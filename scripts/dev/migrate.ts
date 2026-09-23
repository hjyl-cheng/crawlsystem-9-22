import { createPool } from '@crawlsystem/store/config';
import { migrate } from '@crawlsystem/store/migrate';
const pool=createPool();try {await migrate(pool);console.log('M1 migration applied or verified');}finally {await pool.end();}
