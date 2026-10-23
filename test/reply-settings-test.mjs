import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';

const fixture=await createWorkspaceFixture();
after(()=>fixture.close());
const {getConfig,setRuntimeConfig,storeConfigForChat}=await import('../src/config.js');
const {resolveContextTier}=await import('../src/prompt.js');
const {Orchestrator}=await import('../src/orchestrator.js');
const request=async(method,chatKey,fields)=>{
 const response=await fetch(fixture.origin+'/api/platform/reply-settings'+(method==='GET'?'?chatKey='+encodeURIComponent(chatKey):''),{method,headers:{cookie:fixture.cookie,'content-type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({chatKey,...fields})})});
 return {status:response.status,body:await response.json()};
};

test('HTTP group/private probability persists independently, with CAS and null inheritance',async()=>{
 const unrelated=JSON.stringify({funding:getConfig().productionBudget.funding,speech:getConfig().speech});
 const first=await request('GET','group:789');assert.equal(first.status,200);assert.equal(first.body.version,0);assert.equal(first.body.replyPercent,null);
 assert.equal((await request('PUT','group:789',{expectedVersion:0,replyPercent:0})).status,200);
 assert.equal((await request('PUT','group:789',{expectedVersion:0,replyPercent:100})).status,409);
 const privateDefault=await request('GET','private:777');assert.equal(privateDefault.body.effectiveReplyPercent,100);
 assert.equal((await request('PUT','private:777',{expectedVersion:0,replyPercent:100})).status,200);
 assert.equal((await request('GET','group:789')).body.effectiveReplyPercent,0);
 const cleared=await request('PUT','group:789',{expectedVersion:1,replyPercent:null});assert.equal(cleared.status,200);assert.equal(cleared.body.version,2);assert.equal(cleared.body.source,'inherited');
 const disk=JSON.parse(fs.readFileSync(path.join(fixture.root,'config.json'),'utf8'));
 assert.deepEqual(disk.store.replyByChat['group:789'],{version:2,replyPercent:null});
 assert.deepEqual(disk.store.replyByChat['private:777'],{version:1,replyPercent:100});
 assert.equal(JSON.stringify({funding:getConfig().productionBudget.funding,speech:getConfig().speech}),unrelated);
});

test('ordinary account cannot read/write other chat; rejects invalid percentages and extra fields',async()=>{
 assert.equal((await request('GET','private:666')).status,403);
 assert.equal((await request('PUT','private:666',{expectedVersion:0,replyPercent:100})).status,403);
 for(const replyPercent of [-1,101,0.5,'40'])assert.equal((await request('PUT','group:789',{expectedVersion:2,replyPercent})).status,400);
 assert.equal((await request('PUT','group:789',{expectedVersion:2,replyPercent:40,admin:true})).status,400);
 assert.equal(getConfig().store.replyByChat['group:789'].version,2);
});

test('one existing trigger handles group/private 0/100 and 40 boundary; explicit summons and mute retained',()=>{
 const before=structuredClone(getConfig()),cfg=structuredClone(before);
 try{
  cfg.store.replyByChat={};setRuntimeConfig(cfg);
  const decide=(chatKey,roll=0,entry={text:'ordinary',atMe:false})=>resolveContextTier({cfg:storeConfigForChat(chatKey),isPrivate:chatKey.startsWith('private:'),roll,triggerEntries:[entry]});
  assert.equal(decide('private:777',99.99).shouldRespond,true);
  for(const chatKey of ['group:789','private:777']){
   cfg.store.replyByChat[chatKey]={version:1,replyPercent:0};assert.equal(decide(chatKey,0).shouldRespond,false);
   cfg.store.replyByChat[chatKey].replyPercent=100;assert.equal(decide(chatKey,99.99).shouldRespond,true);
   cfg.store.replyByChat[chatKey].replyPercent=40;assert.equal(decide(chatKey,39.99).shouldRespond,true);assert.equal(decide(chatKey,40).shouldRespond,false);
  }
  cfg.store.replyByChat['group:789'].replyPercent=0;
  assert.equal(decide('group:789',99,{text:'summon',atMe:true}).shouldRespond,true);
  cfg.store.replyByChat['group:789'].replyPercent=100;cfg.commandMute={enabled:true,active:{'789':0}};
  assert.equal(decide('group:789',0).shouldRespond,false);
 }finally{setRuntimeConfig(before);}
});

test('explicit zero prevents active-topic bypass, null restores it; changing settings cancels pending only',()=>{
 const before=structuredClone(getConfig()),cfg=structuredClone(before),wakes=[],reads=[];
 try{
  cfg.chatActive={...cfg.chatActive,enabled:true};cfg.store.replyByChat={'group:789':{version:1,replyPercent:0}};setRuntimeConfig(cfg);
  const runtime=new Orchestrator({store:{markEntryRead:(...args)=>reads.push(args)},sessions:{},onebot:{}});
  runtime.scheduleWake=(...args)=>wakes.push(args);
  const topic={topic:'test topic',until:Date.now()+60000};runtime.activeTopics.set('group:789',topic);
  runtime.onIncoming('group:789',{id:'zero',text:'ordinary',atMe:false});assert.equal(wakes.length,0);assert.equal(reads.length,1);
  cfg.store.replyByChat['group:789'].replyPercent=null;
  runtime.onIncoming('group:789',{id:'inherited',text:'ordinary',atMe:false});assert.equal(wakes.length,1);
  runtime.pendingWake.add('group:789');runtime.verifiedWakes.add('group:789');runtime.activeRuns.set('group:789','running');
  runtime.replySettingsChanged('group:789');
  assert.equal(runtime.pendingWake.has('group:789'),false);assert.equal(runtime.verifiedWakes.has('group:789'),false);
  assert.equal(runtime.activeRuns.get('group:789'),'running');assert.equal(runtime.activeTopics.get('group:789'),topic);
 }finally{setRuntimeConfig(before);}
});
