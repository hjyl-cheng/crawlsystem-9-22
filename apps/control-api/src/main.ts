import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { loadSigningKey } from '@crawlsystem/http/auth';
import { listen } from '@crawlsystem/http/runtime';
import { createControlApi } from './app.ts';
const pool=createPool();
await listen(createControlApi({store:new Store(pool),signingKey:loadSigningKey(),logger:true,allowedOrigin:process.env.CONSOLE_ORIGIN}),pool,Number(process.env.CONTROL_PORT ?? '18100'));
