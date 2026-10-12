import test from 'node:test';
import assert from 'node:assert/strict';
import {channelUnavailablePage,confirmedChannelRemoval} from '../src/youtube/channel-removal.ts';
import type {RawResponse} from '../src/raw-archive.ts';
const id='UC1234567890123456789012',at=new Date().toISOString();
const page:RawResponse={endpoint:'https://www.youtube.com/youtubei/v1/browse',method:'POST',status:200,captured_at:at,body:JSON.stringify({alerts:[{alertRenderer:{text:{simpleText:'This channel is not available.'}}}]})};
const absent:RawResponse={endpoint:'https://www.googleapis.com/youtube/v3/channels',method:'GET',status:200,captured_at:at,body:'{"items":[]}'};
test('channel removal needs explicit webpage evidence and successful official absence',()=>{
 assert.equal(channelUnavailablePage([page],id),true);assert.equal(confirmedChannelRemoval([page,absent],id),true);
 for(const evidence of [[page],[absent],[{...page,status:404},absent],[page,{...absent,status:500}],[page,{...absent,body:'{"items":[{"id":"'+id+'"}]}'}],[{...page,body:'{"error":{"message":"Network failed"}}'},absent]])assert.equal(confirmedChannelRemoval(evidence,id),false);
 const exists={...page,body:JSON.stringify({metadata:{channelMetadataRenderer:{externalId:id,title:'Existing channel'}}})};assert.equal(confirmedChannelRemoval([exists,page,absent],id),false,'an About/tab error cannot remove an existing channel');
});
