import type {Pool,PoolClient} from 'pg';
import {contentHash} from '@crawlsystem/contracts/hash';
import {ConfigCommandSchema,ConfigSnapshotSchema,ConfigHistorySchema,RuntimeSettingsSchema,CONFIG_CATALOG,changedSettings,settingValue,type RuntimeSettings} from '../../contracts/src/configuration.ts';
import {StoreError} from './index.ts';

export async function runtimeSettings(db:Pool|PoolClient,workspace:string,fallback:RuntimeSettings){
 const row=(await db.query('SELECT * FROM control.runtime_settings WHERE workspace_id=$1',[workspace])).rows[0];
 return {version:row?.version??0,source:row?'DATABASE' as const:'ENVIRONMENT' as const,settings:row?RuntimeSettingsSchema.parse(row.settings):fallback,
  updated_at:row?new Date(row.updated_at).toISOString():null,operator:row?.operator??null};
}
export async function settingsSnapshot(db:Pool|PoolClient,workspace:string,fallback:RuntimeSettings){
 const snapshot=await runtimeSettings(db,workspace,fallback);
 const rows=(await db.query('SELECT name,version,observed_at FROM control.runtime_settings_consumers WHERE workspace_id=$1 ORDER BY name LIMIT 100',[workspace])).rows;
 return ConfigSnapshotSchema.parse({...snapshot,consumers:rows.map(r=>({...r,observed_at:new Date(r.observed_at).toISOString()}))});
}
export async function publishSettings(db:PoolClient,workspace:string,operator:string,raw:unknown,fallback:RuntimeSettings){
 const command=ConfigCommandSchema.parse(raw),hash=contentHash(command);
 await db.query("SELECT pg_advisory_xact_lock(hashtext('runtime-settings:'||$1))",[workspace]);
 const previous=(await db.query('SELECT request_hash FROM control.runtime_settings_history WHERE workspace_id=$1 AND command_id=$2',[workspace,command.command_id])).rows[0];
 if(previous){if(previous.request_hash!==hash)throw new StoreError('CONFLICT','Configuration command has different content');return settingsSnapshot(db,workspace,fallback);}
 const current=await runtimeSettings(db,workspace,fallback);
 if(current.version!==command.expected_version)throw new StoreError('CONFLICT','Configuration changed; refresh before publishing');
 const meta=CONFIG_CATALOG.find(v=>v[0]===command.key)!;
 if(meta[4]==='high'&&!command.confirm_risk)throw new StoreError('INVALID_REQUEST','Confirm this high risk change',400);
 const settings=changedSettings(current.settings,command.key,command.value),before=settingValue(current.settings,command.key),after=settingValue(settings,command.key);
 if(contentHash(before)===contentHash(after))throw new StoreError('INVALID_REQUEST','Configuration value has not changed',400);
 const version=current.version+1;
 await db.query(`INSERT INTO control.runtime_settings(workspace_id,version,settings,operator) VALUES($1,$2,$3,$4)
  ON CONFLICT(workspace_id) DO UPDATE SET version=EXCLUDED.version,settings=EXCLUDED.settings,operator=EXCLUDED.operator,updated_at=clock_timestamp()`,[workspace,version,settings,operator]);
 await db.query(`INSERT INTO control.runtime_settings_history(workspace_id,command_id,version,request_hash,key,before_value,after_value,reason,operator)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[workspace,command.command_id,version,hash,command.key,JSON.stringify(before),JSON.stringify(after),command.reason,operator]);
 return settingsSnapshot(db,workspace,fallback);
}
export async function settingsHistory(db:Pool,workspace:string,limit:number,offset:number){
 const rows=(await db.query(`SELECT command_id,version,key,before_value AS before,after_value AS after,reason,operator,created_at
  FROM control.runtime_settings_history WHERE workspace_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3`,[workspace,limit+1,offset])).rows;
 return ConfigHistorySchema.parse({items:rows.slice(0,limit).map(r=>({...r,created_at:new Date(r.created_at).toISOString()})),next_cursor:rows.length>limit?String(offset+limit):null});
}
export async function settingsConsumed(db:Pool|PoolClient,workspace:string,name:string,version:number){
 await db.query(`INSERT INTO control.runtime_settings_consumers(workspace_id,name,version) VALUES($1,$2,$3)
  ON CONFLICT(workspace_id,name) DO UPDATE SET version=EXCLUDED.version,observed_at=clock_timestamp()
  WHERE EXCLUDED.version>=control.runtime_settings_consumers.version`,[workspace,name,version]);
}
