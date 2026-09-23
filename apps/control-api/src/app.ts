import { z } from 'zod';
import { CONTRACT_VERSION, CreatePlanSchema, CancelPlanSchema, ExecutionEventSchema, HeartbeatSchema, IdSchema } from '@crawlsystem/contracts';
import { requireRole } from '@crawlsystem/store';
import { createServer, pagination, planId, type ServerOptions } from '@crawlsystem/http';

export function createControlApi(options:ServerOptions) {
  const app=createServer('control',options),store=options.store;
  app.get('/v1/session',async request=>({...request.principal,contract_version:CONTRACT_VERSION}));
  app.post('/v1/plans',async request=>store.createPlan(request.principal,CreatePlanSchema.parse(request.body)));
  app.get('/v1/plans',async request=>{const q=pagination(request.query);return store.listPlans(request.principal,q.limit,q.offset,q.status);});
  app.get('/v1/plans/:id',async request=>store.getPlan(request.principal,planId(request)));
  app.get('/v1/plans/:id/input',async request=>{requireRole(request.principal,'worker');return store.getInput(request.principal,planId(request));});
  app.post('/v1/plans/:id/cancel',async request=>store.cancel(request.principal,planId(request),CancelPlanSchema.parse(request.body)));
  app.post('/v1/plans/:id/events',async request=>store.event(request.principal,planId(request),ExecutionEventSchema.parse(request.body)));
  app.get('/v1/receipts/:id',async request=>store.getReceipt(request.principal,planId(request)));
  app.get('/v1/channels',async request=>{const q=pagination(request.query);return store.listChannels(request.principal,q.limit,q.offset);});
  app.get('/v1/channels/:id',async request=>store.getChannel(request.principal,z.object({id:IdSchema}).parse(request.params).id));
  app.post('/v1/workers/heartbeat',async request=>store.heartbeat(request.principal,HeartbeatSchema.parse(request.body)));
  app.get('/v1/workers',async request=>{const q=pagination(request.query);return store.listWorkers(request.principal,q.limit,q.offset);});
  app.get('/v1/errors',async request=>{const q=pagination(request.query);return store.listErrors(request.principal,q.limit,q.offset);});
  return app;
}
