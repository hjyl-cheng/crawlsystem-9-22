/** Fault-injection entrypoint for real integration tests; never a production service. */
import { setTimeout as delay } from 'node:timers/promises';
import { Store, type Intent } from '@crawlsystem/store';
import { createPool } from '@crawlsystem/store/config';
import { createWorkflowStarter } from '@crawlsystem/execution-client';
import { IntentDispatcher } from '../../apps/control-api/src/dispatcher.ts';
import { temporalOptions } from '../../apps/control-api/src/temporal-config.ts';

const workspace = process.env.M1_WORKSPACE_ID;
if (!workspace?.startsWith('main-joint-')) throw new Error('Only an isolated main-joint-* workspace may use the fault injector');
const pool = createPool();
const adapter = await createWorkflowStarter(temporalOptions());
class ObservedStore extends Store {
  override async finishIntent(intent: Intent, state: 'DONE'|'SKIPPED', runId: string|null = null) {
    await super.finishIntent(intent, state, runId);
    process.stdout.write(JSON.stringify({ event: 'intent_finished', plan_id: intent.plan_id, kind: intent.kind, state, run_id: runId }) + '\n');
  }
}
const dispatcher = new IntentDispatcher(new ObservedStore(pool), {
  async start(input) {
    const result = await adapter.start(input);
    if (process.env.M1_TEST_DROP_START_ACK === '1') {
      // The real RPC has succeeded. Exit without finishIntent or releasing the
      // database lease, exactly as a process crash in this window would do.
      await new Promise<never>(() => process.stdout.write(JSON.stringify({ event: 'start_ack_lost', ...result }) + '\n', () => process.exit(86)));
    }
    return result;
  },
  cancel: id => adapter.cancel(id),
}, workspace);
let stopping = false;
const stop = () => { stopping = true; };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  while (!stopping) {
    try { if (!await dispatcher.tick()) await delay(200); }
    catch { process.stderr.write('Test dispatcher dependency unavailable; intent retained\n'); await delay(1000); }
  }
} finally { await adapter.close(); await pool.end(); }
