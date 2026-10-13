import {z} from 'zod';
import {UpdateLimitsSchema,DiscoveryLimitsSchema} from './index.ts';
import {ProxyPolicySchema} from './proxy-policy.ts';

export const QueryCollectionLimitsSchema=z.strictObject({
  enabled:z.boolean().default(true),daily_binding_limit:z.number().int().min(0).max(500).default(50),
  max_auto_bindings:z.number().int().min(0).max(10000).default(5000),min_support_channels:z.number().int().min(2).max(5).default(2),
});
export type QueryCollectionLimits=z.infer<typeof QueryCollectionLimitsSchema>;

export const RuntimeSettingsSchema=z.strictObject({
  update:UpdateLimitsSchema,discovery:DiscoveryLimitsSchema,proxy:ProxyPolicySchema,
  query_collection:QueryCollectionLimitsSchema.default(()=>QueryCollectionLimitsSchema.parse({})),
  alerts:z.strictObject({archive_delay_seconds:z.number().int().min(60).max(86400).default(600),evidence_pending_count:z.number().int().min(0).max(100000).default(0)}),
}).refine(v=>v.discovery.api_reserve<=v.update.api_daily_limit,'search reserve exceeds API daily limit');
export type RuntimeSettings=z.infer<typeof RuntimeSettingsSchema>;
export const defaultSettings=():RuntimeSettings=>RuntimeSettingsSchema.parse({update:{},discovery:{},proxy:{},alerts:{}});
export const CONFIG_CATALOG=[
  ['update.enabled','自动更新开关','更新采集','boolean','high','关闭后暂停自动更新和导入调度；已有计划继续执行。并发由在线 Worker 的空位决定。'],
  ['update.auto_domains','自动更新范围','更新采集','domains','high','频道资料、视频与评论、Agent 画像；手动更新可单独选择。'],
  ['update.api_daily_limit','Data API 每日配额','更新采集','number','high','本系统准入上限；修改不会增加服务商提供的实际配额。'],
  ['discovery.enabled','自动搜索开关','搜索与准入','boolean','high','停止领取新的搜索任务；已领取任务按冻结参数完成。'],
  ['discovery.max_active_runs','搜索同时运行上限','搜索与准入','number','high','新搜索领取时检查，降低时保留已运行任务。'],
  ['discovery.daily_run_limit','搜索每日任务上限','搜索与准入','number','high','UTC 每日新搜索数，失败重试不重复计数。'],
  ['discovery.max_pages','每次搜索页数上限','搜索与准入','number','medium','领取任务时冻结，仅影响后续新任务。'],
  ['discovery.continue_min_new','搜索继续翻页门槛','搜索与准入','number','medium','当前页新增频道达到此数量才继续翻页。'],
  ['discovery.min_subscribers','候选最低订阅数','搜索与准入','number','high','新搜索任务的合格门槛；历史候选保留原资格判断。'],
  ['discovery.api_reserve','旧搜索 API 预留','搜索与准入','number','high','仅用于旧 Data API 搜索重试；网页搜索不占配额。'],
  ['discovery.backlog_limit','搜索积压暂停门槛','搜索与准入','number','medium','候选与导入积压达到此数量时暂停领取新搜索。'],
  ['discovery.auto_admit','合格候选自动准入','搜索与准入','boolean','high','将合格候选加入导入队列；人工审核始终可用。'],
  ['discovery.import_buffer','导入排队缓冲上限','搜索与准入','number','medium','自动准入保持的排队量，剩余合格频道留在候选列表。'],
  ['query_collection.enabled','自动收集搜索词','搜索词收集','boolean','medium','从已完成采集的频道资料、标签和视频标题提取候选词。'],
  ['query_collection.daily_binding_limit','每天新增或唤醒上限','搜索词收集','number','medium','UTC 每日新增和唤醒共用额度；搜索执行仍受搜索预算和积压门槛限制。'],
  ['query_collection.max_auto_bindings','自动新增搜索词总量上限','搜索词收集','number','medium','达到上限后保留候选；人工添加和已迁入的词不计入。'],
  ['query_collection.min_support_channels','最低支持频道数','搜索词收集','number','medium','同一国家、分类下至少由这些不同频道提供来源；重复采集不增加支持。'],
  ['proxy.cooldown_base_seconds','代理初次冷却秒数','代理规则','number','high','连续失败后冷却，随后指数增长。新失败使用新规则。'],
  ['proxy.cooldown_max_seconds','代理最长冷却秒数','代理规则','number','high','连续失败冷却的上限；已有冷却截止时间保持。'],
  ['proxy.blocked_cooldown_seconds','代理被封冷却秒数','代理规则','number','high','YouTube 拒绝出口时冷却，并重新通过内容探测。'],
  ['proxy.failures_before_cooldown','代理连续失败冷却门槛','代理规则','number','high','达到此连续失败次数后进入冷却。'],
  ['proxy.cooldowns_before_failed','代理失败退役门槛','代理规则','number','high','无成功恢复的连续冷却次数达到门槛后报告失败。'],
  ['proxy.trial_passes','代理试用通过次数','代理规则','number','high','新代理或被封代理需要连续通过的内容探测次数。'],
  ['alerts.archive_delay_seconds','统计归档延迟告警秒数','告警阈值','number','medium','最旧未归档事件超过阈值并持续 5 分钟触发现有告警。'],
  ['alerts.evidence_pending_count','失败证据积压告警门槛','告警阈值','number','medium','待保留失败证据超过此数量并持续 30 分钟触发现有告警。'],
] as const;
export type ConfigKey=typeof CONFIG_CATALOG[number][0];
export const ConfigKeySchema=z.enum(CONFIG_CATALOG.map(v=>v[0]));
export const ConfigValueSchema=z.union([z.boolean(),z.number().int(),z.array(z.enum(['ABOUT','VIDEO','AGENT'])).max(3)]);
export type ConfigValue=z.infer<typeof ConfigValueSchema>;
export function settingValue(settings:RuntimeSettings,key:ConfigKey):ConfigValue {
  const [group,field]=key.split('.') as [keyof RuntimeSettings,string];
  return (settings[group] as unknown as Record<string,ConfigValue>)[field]!;
}
export function changedSettings(settings:RuntimeSettings,key:ConfigKey,value:ConfigValue):RuntimeSettings {
  const [group,field]=key.split('.') as [keyof RuntimeSettings,string];
  return RuntimeSettingsSchema.parse({...settings,[group]:{...settings[group],[field]:value}});
}
export const ConfigCommandSchema=z.strictObject({command_id:z.uuid(),expected_version:z.number().int().nonnegative(),key:ConfigKeySchema,value:ConfigValueSchema,
  reason:z.string().trim().min(3).max(200),confirm_risk:z.boolean().default(false)});
export type ConfigCommand=z.infer<typeof ConfigCommandSchema>;
export const ConfigSnapshotSchema=z.strictObject({version:z.number().int().nonnegative(),source:z.enum(['ENVIRONMENT','DATABASE']),settings:RuntimeSettingsSchema,
  updated_at:z.iso.datetime().nullable(),operator:z.string().nullable(),consumers:z.array(z.strictObject({name:z.string(),version:z.number().int().nonnegative(),observed_at:z.iso.datetime()})).max(100)});
export const ConfigHistoryItemSchema=z.strictObject({command_id:z.uuid(),version:z.number().int().positive(),key:ConfigKeySchema,before:ConfigValueSchema,after:ConfigValueSchema,
  reason:z.string(),operator:z.string(),created_at:z.iso.datetime()});
export const ConfigHistorySchema=z.strictObject({items:z.array(ConfigHistoryItemSchema).max(100),next_cursor:z.string().nullable()});
export type ConfigSnapshot=z.infer<typeof ConfigSnapshotSchema>;
export type ConfigHistoryItem=z.infer<typeof ConfigHistoryItemSchema>;
