import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-verified-free-'));
process.env.QQ_AGENT_DATA_DIR=dir;
const {DEFAULT_CONFIG,setRuntimeConfig}=await import('../src/config.js');
const {createPaidCallGuard,createPaidCallStorage,validateProductionBudgetConfig,runWithPaidConversation,productionPaidCallGuard,closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
const {runWithConversationContext}=await import('../src/conversation-context.js');
const {chatCompletionWithRetry}=await import('../src/llm.js');
const {FREE_MODEL:model,FREE_ENDPOINT:endpoint}=await import('../src/verified-free-model.js');
const prices={inputCnyPerMillion:0,cacheHitCnyPerMillion:0,outputCnyPerMillion:0,reasoningIncluded:true};
const config=()=>({...structuredClone(DEFAULT_CONFIG),api:{...DEFAULT_CONFIG.api,baseUrl:endpoint,model,apiKey:'fixture-free-key',fallbackModels:[]},allow:{groups:['123'],private:['123']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint,model,prices:{...prices},defaultDailyLimitCny:0,outputCap:256,initialSpent:{},overrides:{},funding:{'group:123':{mode:'platform',enabled:true},'private:123':{mode:'platform',enabled:true}}}});
const context=key=>({botId:'primary',conversationKey:key,actorId:'fixture',requestId:crypto.randomUUID(),fundingRef:{id:'platform',version:1},personaRef:{id:'fixture',version:1}});
const body={model,stream:false,messages:[{role:'user',content:'Inert fixture'}]};
test.after(()=>{closeProductionPaidCallGuard();fs.rmSync(dir,{recursive:true,force:true});});

test('zero prices authorize only the exact verified endpoint and model',()=>{
 assert.equal(validateProductionBudgetConfig(config()).model,model);
 for(const edit of [p=>p.model='arbitrary:free',p=>p.endpoint='https://example.invalid/alpha',p=>p.prices.cacheHitCnyPerMillion=1]){
  const cfg=config();edit(cfg.productionBudget);assert.throws(()=>validateProductionBudgetConfig(cfg),{code:'PAID_CALL_DENIED'});
 }
});
test('free calls preserve paid balances and history across restart, and recheck revocation',()=>{
 const cfg=config(),store=createPaidCallStorage(path.join(dir,'guard.sqlite'));
 try{
  cfg.productionBudget.model=cfg.api.model='fixture-paid';
  cfg.productionBudget.prices={inputCnyPerMillion:2,cacheHitCnyPerMillion:.1,outputCnyPerMillion:4,reasoningIncluded:true};
  cfg.productionBudget.defaultDailyLimitCny=1;
  let guard=createPaidCallGuard({storage:store,config:()=>cfg});
  runWithConversationContext(context('group:123'),()=>{
   const token=guard.prepare({api:cfg.api,body:{...body,model:'fixture-paid'},platformCredential:cfg.api.apiKey});guard.dispatch(token);guard.unknown(token);
  });
  cfg.productionBudget.model=cfg.api.model=model;cfg.productionBudget.prices={...prices};
  cfg.productionBudget.defaultDailyLimitCny=0;guard.status('group:123');
  const prior=store.readText('conversation-budget');
  for(const key of ['group:123','private:123'])runWithConversationContext(context(key),()=>{
   const token=guard.prepare({api:cfg.api,body,platformCredential:cfg.api.apiKey});
   assert.equal(token.free,true);assert.equal(token.body.max_tokens,256);
   guard.dispatch(token);guard.complete(token,{text:JSON.stringify({model,usage:{prompt_tokens:9,completion_tokens:3,total_tokens:12}})});
   assert.equal(guard.status(key).spentCny,0);
  });
  assert.equal(store.readText('conversation-budget'),prior);
  guard=createPaidCallGuard({storage:store,config:()=>cfg});assert.equal(guard.records().length,3);
  assert.ok(guard.records().filter(r=>r.state==='settled').every(r=>r.amountCny===0&&r.actualCny===0));
  assert.equal(guard.records().find(r=>r.state==='unknown').amountCny>0,true);
  runWithConversationContext(context('group:123'),()=>{
   const token=guard.prepare({api:cfg.api,body,platformCredential:cfg.api.apiKey});
   cfg.productionBudget.funding['group:123'].enabled=false;
   assert.throws(()=>guard.dispatch(token),{code:'PAID_CALL_DENIED'});guard.release(token);
  });
 }finally{store.close();}
});
test('free model shares the native tool pipeline; denied calls never fall back to paid models',async()=>{
 const cfg=config(),original=globalThis.fetch;setRuntimeConfig(cfg);
 let requests=0;
 globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({error:{code:'quota_exhausted'}}),{status:429});};
 try{
  cfg.api.fallbackModels=[{model:'deepseek/deepseek-v4.1-flash'}];
  await assert.rejects(runWithPaidConversation('private:123',()=>chatCompletionWithRetry({messages:body.messages},2)),{code:'COMMANDCODE_HTTP_429'});
  assert.equal(requests,1);assert.equal(productionPaidCallGuard().records().at(-1).state,'unknown');
  cfg.api.fallbackModels=[];
  globalThis.fetch=async(url,opts)=>{
   requests++;assert.equal(String(url),endpoint+'/generate');assert.equal(JSON.parse(opts.body).params.model,model);
   return new Response([{type:'tool-call',toolCallId:'fixture_call',toolName:'probe_ack',input:{ok:true}},{type:'finish',finishReason:'tool-calls',totalUsage:{inputTokens:9,outputTokens:3,totalTokens:12}}].map(x=>JSON.stringify(x)).join('\n')+'\n',{status:200});
  };
  const result=await runWithPaidConversation('group:123',()=>chatCompletionWithRetry({messages:body.messages,tools:[{type:'function',function:{name:'probe_ack',parameters:{type:'object',properties:{ok:{type:'boolean'}}}}}]},0));
  assert.equal(result.message.tool_calls[0].function.name,'probe_ack');
  assert.equal(productionPaidCallGuard().records().at(-1).actualCny,0);
 }finally{globalThis.fetch=original;closeProductionPaidCallGuard();}
});
