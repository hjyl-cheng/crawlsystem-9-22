import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,writeFileSync,copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// A fresh, separately owned database. Never reset the shared preview database.
const stamp=Date.now(),name=`crawlsystem_m1_r3_${stamp}_test`,role=`crawlsystem_r3_test_${stamp}`,file='.runtime/r3-test.env';
if(existsSync(file) && !process.argv.includes('--fresh')) {console.log('R3 isolated database configuration already prepared');process.exit(0);}
if(existsSync(file))copyFileSync(file,`.runtime/r3-test-${stamp}.env`);
const kubectl=(args:string[],input?:string)=>execFileSync('kubectl',args,{encoding:'utf8',input,stdio:['pipe','pipe','pipe']});
const primary=kubectl(['-n','db','get','pods','-l','cnpg.io/instanceRole=primary','-o','jsonpath={.items[0].metadata.name}']);
const psql=(sql:string)=>kubectl(['-n','db','exec','-i',primary,'--','psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-tA'],sql);
if(psql(`SELECT 1 FROM pg_database WHERE datname='${name}';`).trim()) throw new Error('Isolated database already exists; recover its configuration without resetting it');
if(psql(`SELECT 1 FROM pg_roles WHERE rolname='${role}';`).trim()) throw new Error('Test role already exists; do not replace its credential');
const password=randomBytes(32).toString('hex');
psql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nCREATE DATABASE ${name} OWNER ${role};\n`);
const url=new URL(process.env.DATABASE_URL!);url.username=role;url.password=password;url.pathname=`/${name}`;
mkdirSync('.runtime',{recursive:true,mode:0o700});
const env={DATABASE_URL:url.href,PG_CA_FILE:process.env.PG_CA_FILE!,PG_TLS_SERVERNAME:process.env.PG_TLS_SERVERNAME??'crawler-pg-pool.db.svc.cluster.local',PG_POOL_MAX:'2'};
writeFileSync(file,Object.entries(env).map(([k,v])=>`${k}=${v}\n`).join(''),{mode:0o600});
console.log(`Created separate database ${name} owned by ${role}`);
