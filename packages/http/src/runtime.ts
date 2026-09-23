import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
export async function listen(app:FastifyInstance,pool:Pool,port:number):Promise<void> {
  const host=process.env.HOST ?? '127.0.0.1';
  if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid listener port');
  await app.listen({host,port});
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await app.close();await pool.end();};
  process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
}
