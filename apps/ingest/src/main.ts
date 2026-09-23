import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { loadSigningKey } from '@crawlsystem/http/auth';
import { listen } from '@crawlsystem/http/runtime';
import { createIngestApi } from './app.ts';
const pool=createPool();
await listen(createIngestApi({store:new Store(pool),signingKey:loadSigningKey(),logger:true}),pool,Number(process.env.INGEST_PORT ?? '18101'));
