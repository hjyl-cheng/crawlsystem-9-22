import type { Pool,PoolClient } from 'pg';
import {userInfo} from 'node:os';
import {insertAudit} from './console-audit.ts';
import type {Account} from './console-auth.ts';
const actor=()=>('cli:'+userInfo().username).slice(0,160);
async function updateAccount(pool:Pool,username:string,action:string,update:(client:PoolClient)=>Promise<void>) {
  const client=await pool.connect();let discard=false;
  try {
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL transaction_timeout='5s'");
    const account=await client.query('SELECT username,workspace_id FROM console.accounts WHERE username=$1 FOR UPDATE',[username]);
    if(!account.rowCount)throw new Error('account not found');
    await update(client);
    await insertAudit(client,{workspace_id:account.rows[0].workspace_id,actor:actor(),username:null,role:null,kind:'ACCOUNT',action,target:username,request_id:null,command_id:null},true);
    await client.query('COMMIT');
  } catch(error) {
    discard=/connection|timeout/i.test((error as Error).message);if(!discard)await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;
  } finally {client.release(discard);}
}
export async function setAccountPassword(pool:Pool,username:string,record:{salt:string;password_hash:string}) {
  await updateAccount(pool,username,'account.set_password',async client=>{
    await client.query('UPDATE console.accounts SET password_salt=$2,password_hash=$3,updated_at=clock_timestamp() WHERE username=$1',[username,record.salt,record.password_hash]);
    await client.query('DELETE FROM console.sessions WHERE username=$1',[username]);
  });
}
export async function setAccountDisabled(pool:Pool,username:string,disabled:boolean) {
  await updateAccount(pool,username,disabled?'account.disable':'account.enable',async client=>{
    await client.query('UPDATE console.accounts SET disabled_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE username=$1',[username,disabled]);
    if(disabled)await client.query('DELETE FROM console.sessions WHERE username=$1',[username]);
  });
}
export async function addAccount(pool:Pool,account:Account,importing=false){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL transaction_timeout='5s'");
    const result=await client.query(`INSERT INTO console.accounts(username,subject,workspace_id,role,password_salt,password_hash) VALUES($1,$2,$3,$4,$5,$6) ${importing?'ON CONFLICT(username) DO NOTHING':''}`,[account.username,account.subject,account.workspace_id,account.role,account.salt,account.password_hash]);
    if(result.rowCount)await insertAudit(client,{workspace_id:account.workspace_id,actor:actor(),username:null,role:null,kind:'ACCOUNT',action:importing?'account.import':'account.add',target:account.username,request_id:null,command_id:null},true);
    await client.query('COMMIT');return !!result.rowCount;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
