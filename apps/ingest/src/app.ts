import { SubmissionSchema } from '@crawlsystem/contracts';
import { createServer, type ServerOptions } from '@crawlsystem/http';
export function createIngestApi(options:ServerOptions) {
  const app=createServer('ingest',options);
  app.post('/v1/submissions',async request=>options.store.apply(request.principal,SubmissionSchema.parse(request.body)));
  return app;
}
