import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {failureEnvelope} from '../src/failure.ts';
import {evidenceReader} from '../../control-api/src/evidence.ts';
import type {Failure} from '@crawlsystem/contracts/analytics';
test('dead letters preserve valid references and discard every fact/body/credential field',()=>{
 const raw={schema_version:'crawl.raw.v1',workspace_id:'test',plan_id:randomUUID(),execution_epoch:1,input_hash:'sha256:'+'a'.repeat(64),channel_id:'test-channel',step:'ABOUT',unit_id:'channel',bucket:'crawl-raw',key:'v1/test/channel.json.gz',sha256:'b'.repeat(64),bytes:10,captured_at:new Date().toISOString()};
 const e=failureEnvelope('SINK','facts.channel',0,'20','INVALID_FACT',3,JSON.stringify({raw,payload:{comments:'private'},cookie:'private',password:'private'}));assert.equal(e.report.raw?.key,raw.key);assert.equal(JSON.stringify(e).includes('private'),false);
 const invalid=failureEnvelope('PARSER','crawl.raw',0,'21','INVALID_MESSAGE',3,'{cookie');assert.equal(invalid.report.raw,null);assert.equal(invalid.report.plan_id,null);
});
test('evidence projection excludes bodies, query credentials and user identity',async()=>{
 const bytes=gzipSync(JSON.stringify({responses:[{endpoint:'https://www.youtube.com/watch?key=private',method:'GET',status:403,body:'private comments visitorData cookies',captured_at:new Date().toISOString()}],owner:{token:'private'}}));
 const ref={bucket:'crawl-evidence',key:'test/object',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 const result=await evidenceReader({get:async()=>bytes,put:async()=>{}})({evidence:ref} as Failure);assert.equal(result.responses[0]?.status,403);assert.equal(JSON.stringify(result).includes('private'),false);assert.equal(result.available,true);
 await assert.rejects(()=>evidenceReader({get:async()=>Buffer.from('corrupt'),put:async()=>{}})({evidence:ref} as Failure),{code:'CONFLICT'});
});
