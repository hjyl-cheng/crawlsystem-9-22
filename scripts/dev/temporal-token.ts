import { readFileSync, writeFileSync } from 'node:fs';
import { TemporalTokenIssuer } from '@crawlsystem/http/temporal-token';
// Local operator/acceptance tools: mint a short Temporal namespace token from the
// ignored signing key (never system/admin). Use with TEMPORAL_API_KEY_FILE.
const [output, ...permissions] = process.argv.slice(2);
if (!output || !permissions.length) throw new Error('Usage: temporal-token <output-file> <namespace>:read|write|worker ...');
const issuer = await TemporalTokenIssuer.fromPem(readFileSync('.runtime/temporal-jwt/signing.pem', 'utf8'), 3600);
writeFileSync(output, await issuer.issue('local-operator', permissions) + '\n', { mode: 0o600 });
console.log(`Temporal token for ${permissions.join(', ')} written (expires in 1 hour)`);
