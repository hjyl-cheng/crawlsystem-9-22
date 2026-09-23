import type { Pool, PoolClient } from 'pg';
import type { Principal } from '@crawlsystem/contracts';

export interface ConsoleSessionRepository {
  consumeAttempt(authority:string,usernameHash:string):Promise<boolean>;
  save(authority:string,hash:string,principal:Principal,lifetimeMs:number,previousHash?:string):Promise<boolean>;
  find(authority:string,hash:string):Promise<Principal|undefined>;
  revoke(authority:string,hash:string):Promise<void>;
}

/** Shared PostgreSQL state. Only SHA-256 session indexes reach the database. */
export class PgConsoleSessions implements ConsoleSessionRepository {
  constructor(private pool:Pool) {}
  private async transaction<T>(authority:string,work:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();let discard=false;
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL transaction_timeout='5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,18230923))',[authority]);
      const result=await work(client);await client.query('COMMIT');return result;
    } catch(error) {
      discard=/connection|timeout/i.test((error as Error).message);
      if(!discard)await client.query('ROLLBACK').catch(()=>{discard=true;});
      throw error;
    } finally {client.release(discard);}
  }
  async consumeAttempt(authority:string,usernameHash:string):Promise<boolean> {
    await this.pool.query(`DELETE FROM m1.console_login_limits WHERE (authority,bucket) IN
      (SELECT authority,bucket FROM m1.console_login_limits WHERE reset_at<=clock_timestamp() ORDER BY reset_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    return this.transaction(authority,async client=>{
      for(const [bucket,max] of [['all',60],['user:'+usernameHash,10]] as const) {
        const row=await client.query(`INSERT INTO m1.console_login_limits(authority,bucket,attempts,reset_at)
          VALUES($1,$2,1,clock_timestamp()+interval '1 minute')
          ON CONFLICT(authority,bucket) DO UPDATE SET attempts=m1.console_login_limits.attempts+1
          WHERE m1.console_login_limits.attempts<$3 RETURNING attempts`,[authority,bucket,max]);
        if(!row.rowCount)return false;
      }
      return true;
    });
  }
  async save(authority:string,hash:string,principal:Principal,lifetimeMs:number,previousHash?:string):Promise<boolean> {
    // Cleanup is a separate short statement so it never locks another authority
    // while holding this authority's capacity lock.
    await this.pool.query(`DELETE FROM m1.console_sessions WHERE (authority,session_hash) IN
      (SELECT authority,session_hash FROM m1.console_sessions WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)`);
    return this.transaction(authority,async client=>{
      if(previousHash)await client.query('DELETE FROM m1.console_sessions WHERE authority=$1 AND session_hash=$2',[authority,previousHash]);
      const count=await client.query('SELECT count(*)::int AS n FROM m1.console_sessions WHERE authority=$1 AND expires_at>clock_timestamp()',[authority]);
      if(count.rows[0].n>=200)return false;
      await client.query(`INSERT INTO m1.console_sessions(authority,session_hash,subject,workspace_id,role,expires_at)
        VALUES($1,$2,$3,$4,$5,clock_timestamp()+($6*interval '1 millisecond'))`,[authority,hash,principal.subject,principal.workspace_id,principal.role,lifetimeMs]);
      return true;
    });
  }
  async find(authority:string,hash:string):Promise<Principal|undefined> {
    const result=await this.pool.query('SELECT subject,workspace_id,role FROM m1.console_sessions WHERE authority=$1 AND session_hash=$2 AND expires_at>clock_timestamp()',[authority,hash]);
    return result.rows[0] as Principal|undefined;
  }
  async revoke(authority:string,hash:string):Promise<void> {
    await this.pool.query('DELETE FROM m1.console_sessions WHERE authority=$1 AND session_hash=$2',[authority,hash]);
  }
}
