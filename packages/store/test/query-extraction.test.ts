import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractQueries} from '../src/query-extraction.ts';
import {RuntimeSettingsSchema,defaultSettings} from '../../contracts/src/configuration.ts';
const fact=(value:unknown,confidence='high')=>({value,confidence});
const profile=()=>({facts:{country:fact('Brazil'),creator_language:fact('Portuguese'),channel_categories:fact({level_1:'Gaming'}),channel_tags:fact({tags:['Short-form Video','Digital Culture','Free Fire','Gameplay Apostado']})}});
test('collected phrases preserve multilingual terms and provenance while rejecting dates, links and generic tags',()=>{
  const words=extractQueries({keywords:['  ＦＲＥＥ   FIRE  ','free fire','jogos brasileiros','뉴스 게임','https://example.com','@name','inscreva-se','NTV NEWS 08 10 2026']},profile(),[{video_id:'abcdefghijk',data:{title:'Campeonato apostado',hashtags:['#gameplay'],keywords:['jogos brasileiros']}}])!;
  assert.ok(words.some(w=>w.text==='free fire'&&w.source_type==='CHANNEL_ABOUT'));
  assert.ok(words.some(w=>w.text==='뉴스 게임'));
  assert.ok(words.some(w=>w.text==='campeonato apostado'&&w.video_id==='abcdefghijk'&&w.source_type==='VIDEO_TITLE'));
  assert.ok(words.every(w=>w.country==='BR'&&w.language==='pt'&&w.category==='Gaming'));
  assert.equal(new Set(words.map(w=>w.text)).size,words.length);
  assert.ok(!words.some(w=>/digital culture|short-form|https|ntv|inscreva|@/.test(w.text)));
});
test('missing or uncertain geography, language or classification is skipped instead of assigned a default',()=>{
  const p=profile();p.facts.country= fact('Atlantis');assert.equal(extractQueries({},p,[]),null);
  assert.ok(extractQueries({country_code:'MX',keywords:['free fire']},p,[])!.every(w=>w.country==='MX'));
  p.facts.country=fact('Brazil','low');assert.equal(extractQueries({},p,[]),null);
  p.facts.creator_language=fact('Portuguese','low');assert.equal(extractQueries({country_code:'BR'},p,[]),null);
  p.facts.creator_language=fact('Portuguese');p.facts.channel_categories=fact({level_1:'Gaming'},'low');assert.equal(extractQueries({country_code:'BR'},p,[]),null);
  p.facts.channel_categories=fact({level_1:'Unknown'});assert.equal(extractQueries({country_code:'BR'},p,[]),null);
});
test('a channel contributes at most twenty phrases and whole prose is not accepted as a keyword',()=>{
  const keywords=Array.from({length:26},(_,i)=>`topic ${String.fromCharCode(97+i)} game`);
  const words=extractQueries({keywords:[...keywords,'a '.repeat(50),'the and of']},profile(),[])!;
  assert.equal(words.length,20);assert.ok(words.every(w=>w.text.length<=80));
});
test('pre-B2 configuration parses with collection defaults without replacing existing budgets',()=>{
  const {query_collection:_,...old}=defaultSettings();old.discovery.daily_run_limit=300;
  const next=RuntimeSettingsSchema.parse(old);assert.equal(next.discovery.daily_run_limit,300);assert.equal(next.query_collection.daily_binding_limit,50);
});
test('repeated profile labels need a public textual anchor and cannot manufacture cross-topic search terms',()=>{
  const p=profile();p.facts.channel_tags=fact({tags:['Children','Parenting Life','Food','Indie Games']});
  const words=extractQueries({keywords:['bolo de cenoura'],description:'Join us for indie games.'},p,[])!;
  assert.ok(words.some(w=>w.text==='indie games'&&w.source_type==='AUTO_TAG'));
  assert.ok(!words.some(w=>['children','parenting life','food'].includes(w.text)));
});
