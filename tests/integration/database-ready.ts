import type {Pool} from 'pg';
import {setTimeout} from 'node:timers/promises';
import {migrate} from '@crawlsystem/store/migrate';
/** Only suite setup waits for the development tunnel to reconnect. Assertions
 * and business requests never get a blanket retry or a reset execution budget. */
export async function prepareDatabase(pool:Pool){
  for(let attempt=0;attempt<5;attempt++){
    try {
      const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
      if(name==='crawlsystem_m1_main_test')throw new Error('The shared preview database contains real data; use a separate integration database');
      await migrate(pool);return;
    }
    catch(error){
      if(attempt===4||!['ECONNREFUSED','ECONNRESET'].includes((error as {code?:string}).code??''))throw error;
      process.stderr.write('integration_database_setup_retry: local connection unavailable\n');
      await setTimeout(1000);
    }
  }
}
