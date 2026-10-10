import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Schema owner remains a migration-only credential. Running services get narrowly scoped logins.
const url=new URL(process.env.DATABASE_URL!),database=url.pathname.slice(1);
if(database!=='crawlsystem_m1_main_test')throw new Error('This deployment script targets only the existing preview database');
const kubectl=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']});
const primary=kubectl(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
const psql=(sql:string)=>kubectl(['-n','db','exec','-i',primary,'--','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d',database,'-tA'],sql);
if(psql("SELECT count(*) FROM pg_namespace WHERE nspname IN ('control','crawl_data');").trim()!=='2')throw new Error('Apply schema 20 before configuring runtime roles');
mkdirSync('.runtime/r3',{recursive:true,mode:0o700});
const credentials=(name:string)=>{
  const file=`.runtime/r3/${name}.password`,exists=psql(`SELECT 1 FROM pg_roles WHERE rolname='${name}';`).trim();
  if(!exists) {
    const password=randomBytes(32).toString('hex');writeFileSync(file,password,{mode:0o600});
    psql(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;`);
  }
  if(!existsSync(file))throw new Error('Recover the stored pipeline runtime credential without replacing it');
  return readFileSync(file,'utf8').trim();
};
const control='crawlsystem_control_v3',sink='crawlsystem_sink_pg_v3',controlPassword=credentials(control),sinkPassword=credentials(sink);
psql(`GRANT CONNECT ON DATABASE ${database} TO ${control},${sink};
GRANT USAGE ON SCHEMA control,crawl_data TO ${control};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA control TO ${control};
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA control TO ${control};
GRANT SELECT ON ALL TABLES IN SCHEMA crawl_data TO ${control};
GRANT USAGE ON SCHEMA control,crawl_data TO ${sink};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA crawl_data TO ${sink};
GRANT EXECUTE ON FUNCTION control.lock_pipeline_plan(text,uuid,integer,text) TO ${sink};
`);
const getSecret=(namespace:string,name:string)=>JSON.parse(kubectl(['-n',namespace,'get','secret',name,'-o','json']));
const original=getSecret('control','control-api-preview'),base=new URL(Buffer.from(original.data['database-url'],'base64').toString());
const put=(namespace:string,name:string,data:Record<string,string>)=>kubectl(['apply','-f','-'],JSON.stringify({apiVersion:'v1',kind:'Secret',metadata:{namespace,name},type:'Opaque',data}));
base.username=control;base.password=controlPassword;original.data['database-url']=Buffer.from(base.href).toString('base64');
put('control','control-api-preview',original.data);
base.username=sink;base.password=sinkPassword;
put('ingest','pipeline-pg-sink',{'database-url':Buffer.from(base.href).toString('base64'),'pg-ca.crt':original.data['pg-ca.crt']});
console.log('Runtime database roles configured: Control writes control; PG sink writes crawl_data');
