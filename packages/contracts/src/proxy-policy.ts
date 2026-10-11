import {z} from 'zod';
export const ProxyPolicySchema=z.strictObject({
  cooldown_base_seconds:z.number().int().min(10).max(3600).default(60),
  cooldown_max_seconds:z.number().int().min(10).max(86400).default(1800),
  blocked_cooldown_seconds:z.number().int().min(10).max(86400).default(600),
  failures_before_cooldown:z.number().int().min(1).max(20).default(3),
  cooldowns_before_failed:z.number().int().min(1).max(20).default(3),
  trial_passes:z.number().int().min(1).max(10).default(2),
}).refine(v=>v.cooldown_base_seconds<=v.cooldown_max_seconds,'base cooldown exceeds maximum');
export type ProxyPolicy=z.infer<typeof ProxyPolicySchema>;
