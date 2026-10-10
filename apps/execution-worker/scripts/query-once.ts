import {readFile} from 'node:fs/promises';
import {QueryRunClaimSchema} from '@crawlsystem/contracts';
import {ExecutionApi,workloadTokenSource} from '@crawlsystem/execution-client/http';
import {workerConfig} from '../src/config.ts';
import {runOne} from '../src/query-runner.ts';
import {FingerprintClient} from '../src/youtube/fingerprint.ts';
import {IdentityStore} from '../src/youtube/identity.ts';
import {LeaseClient} from '../src/youtube/transport.ts';
import {MinioStore} from '../src/raw-archive.ts';
import {DataApi} from '../src/youtube/data-api.ts';

// A single explicitly prepared run for bounded acceptance; never claims another run or changes automation.
const config=workerConfig(),c=config.collection;
if(!c || !config.identityTokenFile || !config.proxyManagerUrl || config.proxyManagerUrl==='direct') throw new Error('Acceptance needs the production web collector and workload identity');
const claim=QueryRunClaimSchema.parse(JSON.parse(await readFile(process.argv[2]!,'utf8')));
const legacyRetry=process.argv[3]==='--legacy-retry';
if(!claim.run || (legacyRetry
  ? claim.run.params.policy_version!=='query-clock-1' || claim.run.params.max_pages>5 || claim.run.attempt<2 || !config.youtubeKeyFile
  : claim.run.params.policy_version!=='query-clock-2-about' || claim.run.params.max_pages>2)) throw new Error('Expected one explicitly prepared bounded run');
const api=new ExecutionApi({controlUrl:config.controlUrl,ingestUrl:config.ingestUrl,timeoutMs:config.httpTimeoutMs,token:workloadTokenSource({controlUrl:config.controlUrl,workerId:config.workerId,timeoutMs:config.httpTimeoutMs,identityToken:()=>readFile(config.identityTokenFile!,'utf8')})});
const session=await api.session();
const secret=async(name:string)=>(await readFile(`${c.minioCredentials}/${name}`,'utf8')).trim();
const gateway=new FingerprintClient(c.gatewayUrl,new IdentityStore(`${c.identityDirectory}/r4-acceptance`,(await readFile(c.identityKeyFile,'utf8')).trim(),config.workerId));
await runOne({api,workerId:config.workerId,workspaceId:session.workspace_id,proxies:new LeaseClient(config.proxyManagerUrl),gateway,
  ...(legacyRetry?{dataApi:new DataApi((await readFile(config.youtubeKeyFile!,'utf8')).trim())}:{}),
  searchStore:new MinioStore(c.minioUrl,'crawl-raw',await secret('access_key'),await secret('secret_key')),enforceBrazil:c.enforceBrazil,
  signal:AbortSignal.timeout(5*60_000),log:record=>process.stdout.write(JSON.stringify(record)+'\n')},claim.run);
