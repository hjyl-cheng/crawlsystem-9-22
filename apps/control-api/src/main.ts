import { Store } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { loadSigningKey } from '@crawlsystem/http/auth';
import { listen } from '@crawlsystem/http/runtime';
import { createControlApi } from './app.ts';
import { ConsoleAuth } from './console-auth.ts';
const pool=createPool();
const consoleAuth=process.env.M1_CONSOLE_ACCOUNTS_FILE ? ConsoleAuth.fromFile(process.env.M1_CONSOLE_ACCOUNTS_FILE,process.env.CONSOLE_COOKIE_SECURE!=='false') : undefined;
await listen(createControlApi({store:new Store(pool),signingKey:loadSigningKey(),logger:true,allowedOrigin:process.env.CONSOLE_ORIGIN,consoleAuth}),pool,Number(process.env.CONTROL_PORT ?? '18100'));
