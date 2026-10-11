import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Principal} from '@crawlsystem/contracts';
import {requireRole} from '@crawlsystem/store';
import {ConsoleAuditPageSchema,ConsoleLoginSummarySchema,type ConsoleAuditQuery} from '../../../packages/contracts/src/console-audit.ts';

export interface AuditStart {workspace_id:string|null;actor:string;username:string|null;role:'reader'|'operator'|null;kind:'LOGIN'|'LOGOUT'|'COMMAND'|'ACCOUNT';action:string;target:string|null;request_id:string|null;command_id:string|null;}
export interface ConsoleAuditRepository {
  begin(input:AuditStart):Promise<string>;
  finish(id:string,status:number):Promise<void>;
  account(username:string):Promise<Pick<AuditStart,'workspace_id'|'actor'|'username'|'role'>|undefined>;
  list(principal:Principal,query:ConsoleAuditQuery):Promise<unknown>;
  summary(principal:Principal):Promise<unknown>;
}
export async function insertAudit(client:Pick<PoolClient,'query'>,input:AuditStart,success=false){
  const id=randomUUID();
  await client.query(`INSERT INTO console.audit(audit_id,workspace_id,actor,username,role,kind,action,target,request_id,command_id,outcome,finished_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $11='SUCCESS' THEN clock_timestamp() ELSE NULL END)`,
  [id,input.workspace_id,input.actor,input.username,input.role,input.kind,input.action,input.target,input.request_id,input.command_id,success?'SUCCESS':'PENDING']);return id;
}
export class PgConsoleAudit implements ConsoleAuditRepository {
  constructor(private pool:Pool){}
  begin(input:AuditStart){return insertAudit(this.pool,input);}
  async finish(id:string,status:number){await this.pool.query(`UPDATE console.audit SET outcome=$2,http_status=$3,finished_at=clock_timestamp() WHERE audit_id=$1 AND outcome='PENDING'`,[id,status<400?'SUCCESS':status<500?'REJECTED':'FAILED',status]);}
  async account(username:string){
    const r=await this.pool.query('SELECT workspace_id,subject AS actor,username,role FROM console.accounts WHERE username=$1',[username]);return r.rows[0];
  }
  async list(principal:Principal,q:ConsoleAuditQuery){
    requireRole(principal,'operator');
    const cursor=q.cursor?.split('|');
    const result=await this.pool.query(`SELECT audit_id,actor,username,role,kind,action,target,request_id,command_id,occurred_at,finished_at,outcome,http_status
      FROM console.audit WHERE workspace_id=$1 AND occurred_at>=clock_timestamp()-($2*interval '1 day')
      AND ($3::text IS NULL OR actor=$3) AND ($4::text IS NULL OR kind=$4) AND ($5::text IS NULL OR outcome=$5)
      AND ($6::timestamptz IS NULL OR (occurred_at,audit_id)<($6::timestamptz,$7::uuid))
      ORDER BY occurred_at DESC,audit_id DESC LIMIT $8`,[principal.workspace_id,q.days,q.actor??null,q.kind??null,q.outcome??null,cursor?.[0]??null,cursor?.[1]??null,q.limit+1]);
    const rows=result.rows.slice(0,q.limit).map(r=>({...r,occurred_at:r.occurred_at.toISOString(),finished_at:r.finished_at?.toISOString()??null}));
    const since=(await this.pool.query('SELECT installed_at FROM console.audit_installation')).rows[0].installed_at.toISOString();
    const last=rows.at(-1);return ConsoleAuditPageSchema.parse({items:rows,next_cursor:result.rows.length>q.limit&&last?last.occurred_at+'|'+last.audit_id:null,observed_at:new Date().toISOString(),history_since:since});
  }
  async summary(principal:Principal){
    requireRole(principal,'operator');
    const result=await this.pool.query(`WITH days AS (SELECT generate_series((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-6,(clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date AS day),
      totals AS (SELECT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*) FILTER(WHERE outcome='SUCCESS')::int AS success,count(*) FILTER(WHERE outcome='REJECTED')::int AS rejected
      FROM console.audit WHERE workspace_id=$1 AND kind='LOGIN' AND occurred_at>=((clock_timestamp() AT TIME ZONE 'Asia/Shanghai')::date-6)::timestamp AT TIME ZONE 'Asia/Shanghai' GROUP BY 1)
      SELECT to_char(d.day,'YYYY-MM-DD') AS day,CASE WHEN d.day<(i.installed_at AT TIME ZONE 'Asia/Shanghai')::date THEN NULL ELSE coalesce(t.success,0) END AS success,
      CASE WHEN d.day<(i.installed_at AT TIME ZONE 'Asia/Shanghai')::date THEN NULL ELSE coalesce(t.rejected,0) END AS rejected,i.installed_at
      FROM days d CROSS JOIN console.audit_installation i LEFT JOIN totals t USING(day) ORDER BY d.day`,[principal.workspace_id]);
    return ConsoleLoginSummarySchema.parse({observed_at:new Date().toISOString(),history_since:result.rows[0].installed_at.toISOString(),points:result.rows.map(({day,success,rejected})=>({day,success,rejected}))});
  }
}

/** Persist intent before executing a human command. A crash leaves PENDING,
 * never a fabricated success. No headers, request bodies or response data are retained. */
export function registerConsoleAudit(app:FastifyInstance,repository:ConsoleAuditRepository){
  const intents=new WeakMap<FastifyRequest,string>();
  app.addHook('preHandler',async request=>{
    if(!['POST','PUT','PATCH','DELETE'].includes(request.method))return;
    const path=request.routeOptions.url;if(!path?.startsWith('/v1/'))return;
    const login=path==='/v1/auth/login',logout=path==='/v1/auth/logout';
    let identity:Pick<AuditStart,'workspace_id'|'actor'|'username'|'role'>|undefined;
    if(login){
      const username=(request.body as {username?:unknown}|undefined)?.username;
      if(typeof username!=='string'||!/^[a-zA-Z0-9_.-]{1,64}$/.test(username))return;
      identity=await repository.account(username)??{workspace_id:null,actor:'unknown',username:null,role:null};
    }else{
      let principal=request.principal;
      // Logout is public for expired cookies; a valid identity is supplied by the route's authentication helper.
      if(logout)principal=(request as FastifyRequest&{logoutPrincipal?:Principal}).logoutPrincipal!;
      if(!principal||!['operator','reader'].includes(principal.role))return;
      identity={workspace_id:principal.workspace_id,actor:principal.subject,username:null,role:principal.role as 'reader'|'operator'};
    }
    const params=request.params as Record<string,unknown>|undefined;
    const target=[params?.id,params?.video].filter(v=>typeof v==='string').join('/').slice(0,200)||null;
    const command=(request.body as {command_id?:unknown}|undefined)?.command_id;
    const commandId=typeof command==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(command)?command:null;
    const id=await repository.begin({...identity,kind:login?'LOGIN':logout?'LOGOUT':'COMMAND',action:login?'login':logout?'logout':request.method+' '+path,target,request_id:request.id,command_id:commandId});intents.set(request,id);
  });
  app.addHook('onSend',async(request,reply,payload)=>{
    const id=intents.get(request);if(id)try{await repository.finish(id,reply.statusCode);intents.delete(request);}catch{request.log.error({audit_id:id},'audit result could not be confirmed');}
    return payload;
  });
}
