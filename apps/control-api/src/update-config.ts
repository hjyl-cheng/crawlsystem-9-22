import { UpdateLimitsSchema } from '@crawlsystem/contracts';

export function updateLimits(env: NodeJS.ProcessEnv = process.env) {
  const number = (name: string) => env[name] === undefined ? undefined : Number(env[name]);
  if (env.UPDATE_SCHEDULER_ENABLED !== undefined && !['true', 'false'].includes(env.UPDATE_SCHEDULER_ENABLED)) throw new Error('Invalid UPDATE_SCHEDULER_ENABLED');
  return UpdateLimitsSchema.parse({
    enabled: env.UPDATE_SCHEDULER_ENABLED === undefined ? undefined : env.UPDATE_SCHEDULER_ENABLED === 'true',
    max_active_plans: number('UPDATE_MAX_ACTIVE_PLANS'), max_agent_plans: number('UPDATE_MAX_AGENT_PLANS'),
    daily_plan_limit: number('UPDATE_DAILY_PLAN_LIMIT'), api_daily_limit: number('UPDATE_API_DAILY_LIMIT'),
    // Comma-separated, e.g. "ABOUT,VIDEO"; empty means nothing is updated automatically.
    auto_domains: env.UPDATE_AUTO_DOMAINS === undefined ? undefined : env.UPDATE_AUTO_DOMAINS.split(',').map(d => d.trim()).filter(Boolean),
  });
}
