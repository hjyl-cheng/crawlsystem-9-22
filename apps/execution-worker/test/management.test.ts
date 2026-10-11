import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkerAdmission} from '../src/management.ts';
import type {WorkerControl} from '../../../packages/contracts/src/workers.ts';
test('search admission follows desired control and ignores late older responses',()=>{
 const gate=new WorkerAdmission(),c:WorkerControl={version:1,desired:'RUNNING',applied_version:0,status:'PENDING',reason:null,changed_at:null,active_plan_ids:[],active_query_run_ids:[],legacy_pending:0};
 assert.equal(gate.accepting,false);gate.apply(c);assert.equal(gate.accepting,true);
 gate.apply({...c,version:2,desired:'PAUSED'});assert.equal(gate.accepting,false);gate.apply(c);assert.equal(gate.accepting,false);
 gate.apply({...c,version:3,desired:'DRAINING'});assert.equal(gate.accepting,false);gate.apply({...c,version:4});assert.equal(gate.accepting,true);
});
