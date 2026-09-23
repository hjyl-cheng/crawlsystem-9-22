import type { Pool,PoolClient } from 'pg';
async function updateAccount(pool:Pool,username:string,update:(client:PoolClient)=>Promise<void>) {
  const client=await pool.connect();let discard=false;
  try {
    await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL transaction_timeout='5s'");
    const account=await client.query('SELECT username FROM console.accounts WHERE username=$1 FOR UPDATE',[username]);
    if(!account.rowCount)throw new Error('account not found');
    await update(client);await client.query('COMMIT');
  } catch(error) {
    discard=/connection|timeout/i.test((error as Error).message);if(!discard)await client.query('ROLLBACK').catch(()=>{discard=true;});throw error;
  } finally {client.release(discard);}
}
export async function setAccountPassword(pool:Pool,username:string,record:{salt:string;password_hash:string}) {
  await updateAccount(pool,username,async client=>{
    await client.query('UPDATE console.accounts SET password_salt=$2,password_hash=$3,updated_at=clock_timestamp() WHERE username=$1',[username,record.salt,record.password_hash]);
    await client.query('DELETE FROM console.sessions WHERE username=$1',[username]);
  });
}
export async function setAccountDisabled(pool:Pool,username:string,disabled:boolean) {
  await updateAccount(pool,username,async client=>{
    await client.query('UPDATE console.accounts SET disabled_at=CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE username=$1',[username,disabled]);
    if(disabled)await client.query('DELETE FROM console.sessions WHERE username=$1',[username]);
  });
}
