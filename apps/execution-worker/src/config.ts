import { IdSchema } from '@crawlsystem/contracts';
import { temporalOptions } from '@crawlsystem/execution-client/config';
import { validateApiUrl } from '@crawlsystem/execution-client/http';

export function workerConfig(env: NodeJS.ProcessEnv = process.env) {
  // Fail closed if a backend environment is accidentally supplied to this process.
  for (const name of Object.keys(env)) if (/^(DATABASE_URL|CONSOLE_DATABASE_URL|M1_.*DATABASE_URL|PGPASSWORD|PGPASSFILE|PGSERVICE|M1_JWT_SECRET(_FILE)?)$/.test(name) && env[name]) throw new Error(`Worker must not receive ${name}`);
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error(`${name} is required`); return value; };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be ${min}..${max}`);
    return value;
  };
  const buildVersion = required('BUILD_VERSION');
  // Exactly one credential source: a pre-issued API token (development) or the
  // projected ServiceAccount token exchanged at Control (cluster).
  const tokenFile = env.WORKER_TOKEN_FILE || undefined, identityTokenFile = env.WORKLOAD_IDENTITY_TOKEN_FILE || undefined;
  if (!tokenFile === !identityTokenFile) throw new Error('Set exactly one of WORKER_TOKEN_FILE or WORKLOAD_IDENTITY_TOKEN_FILE');
  if (buildVersion.length > 120) throw new Error('BUILD_VERSION must be at most 120 characters');
  if (env.YOUTUBE_COLLECTION_MODE && !['web', 'legacy'].includes(env.YOUTUBE_COLLECTION_MODE)) throw new Error('Invalid YOUTUBE_COLLECTION_MODE');
  const web = env.YOUTUBE_COLLECTION_MODE === 'web';
  const collection = web ? {
    gatewayUrl: validateApiUrl(required('FINGERPRINT_GATEWAY_URL')), identityDirectory: required('BROWSER_IDENTITY_DIR'), identityKeyFile: required('BROWSER_IDENTITY_KEY_FILE'),
    minioUrl: validateApiUrl(required('MINIO_ENDPOINT')), minioCredentials: required('MINIO_CREDENTIAL_DIR'), kafkaCredentials: required('KAFKA_CREDENTIAL_DIR'),
    enforceBrazil: env.REQUIRED_EGRESS_COUNTRY === 'BR',
  } : undefined;
  if (web && (!env.YOUTUBE_DATA_API_KEY_FILE || !env.PROXY_MANAGER_URL || env.COLLECTOR_PROXY === 'direct')) throw new Error('Web collection requires a proxy manager and API fallback key');
  if (env.REQUIRED_EGRESS_COUNTRY && env.REQUIRED_EGRESS_COUNTRY !== 'BR') throw new Error('Only the BR egress policy is supported');
  return {
    temporal: temporalOptions(env), controlUrl: validateApiUrl(required('CONTROL_API_URL')), ingestUrl: validateApiUrl(required('INGEST_API_URL')),
    tokenFile, identityTokenFile, workerId: IdSchema.parse(required('WORKER_ID')), serverId: IdSchema.parse(required('SERVER_ID')),
    buildVersion, capacity: integer('WORKER_CAPACITY', 2, 1, 20), heartbeatMs: integer('WORKER_HEARTBEAT_MS', 20_000, 1000, 30_000),
    httpTimeoutMs: integer('WORKER_HTTP_TIMEOUT_MS', 5000, 100, 10_000), drainMs: integer('WORKER_DRAIN_MS', 15_000, 1000, 60_000),
    // Real collection (optional): Data API key file, and the node-local Proxy Manager or explicit direct mode (development only).
    youtubeKeyFile: env.YOUTUBE_DATA_API_KEY_FILE || undefined,
    proxyManagerUrl: env.COLLECTOR_PROXY === 'direct' ? 'direct' as const : env.PROXY_MANAGER_URL ? validateApiUrl(env.PROXY_MANAGER_URL) : undefined,
    // Profile Agent (local-model inference) for the AGENT domain.
    profileAgentUrl: env.PROFILE_AGENT_URL ? validateApiUrl(env.PROFILE_AGENT_URL) : undefined,
    // Query search runs claimed in parallel by this Worker (0 turns search execution off here).
    queryRunnerSlots: integer('QUERY_RUNNER_SLOTS', 1, 0, 4),
    collection,
  };
}
