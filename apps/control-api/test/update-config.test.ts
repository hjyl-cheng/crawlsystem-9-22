import test from 'node:test';
import assert from 'node:assert/strict';
import { updateLimits } from '../src/update-config.ts';

test('the scheduler updates About and Video by itself unless configured otherwise', () => {
  assert.deepEqual(updateLimits({}).auto_domains, ['ABOUT', 'VIDEO']);
  assert.deepEqual(updateLimits({ UPDATE_AUTO_DOMAINS: 'ABOUT, VIDEO' }).auto_domains, ['ABOUT', 'VIDEO']);
  assert.deepEqual(updateLimits({ UPDATE_AUTO_DOMAINS: '' }).auto_domains, [], 'empty: manual updates only');
  assert.throws(() => updateLimits({ UPDATE_AUTO_DOMAINS: 'ABOUT,COMMENTS' }));
  assert.throws(() => updateLimits({ UPDATE_AUTO_DOMAINS: 'ABOUT,ABOUT' }));
  assert.throws(() => updateLimits({ UPDATE_SCHEDULER_ENABLED: 'yes' }));
});
