import { inClusterKubernetes } from '@crawlsystem/http/kubernetes';
import { syncTemporalClientSecrets } from './temporal-cert-sync.ts';
const pairs=(process.env.SYNC_PAIRS??'').split(',').filter(Boolean);
if(!pairs.length) throw new Error('SYNC_PAIRS is required');
const results=await syncTemporalClientSecrets(inClusterKubernetes(),process.env.SYNC_SOURCE_NAMESPACE??'temporal',pairs);
process.stdout.write(JSON.stringify({time:new Date().toISOString(),job:'temporal-cert-sync',results})+'\n');
