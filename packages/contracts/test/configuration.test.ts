import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changedSettings,defaultSettings,ConfigCommandSchema} from '../src/configuration.ts';
test('configuration rejects unknown keys, duplicate domains, invalid cooldown and inconsistent quota',()=>{
 const settings=defaultSettings();
 assert.throws(()=>changedSettings(settings,'update.auto_domains',['ABOUT','ABOUT']));
 assert.throws(()=>changedSettings(settings,'proxy.cooldown_base_seconds',1900));
 assert.throws(()=>changedSettings(settings,'update.api_daily_limit',100));
 assert.throws(()=>changedSettings(settings,'update.enabled',1));
 assert.throws(()=>ConfigCommandSchema.parse({key:'DATABASE_URL',value:1}));
 assert.equal(changedSettings(settings,'discovery.daily_run_limit',300).discovery.daily_run_limit,300);
});
