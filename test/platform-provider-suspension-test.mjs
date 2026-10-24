import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPaidCallStorage,createPaidCallGuard,setPaidCallFundingServices} from '../src/paid-call-guard.js';
import {runWithConversationContext} from '../src/conversation-context.js';

test('pending provider access denies platform calls at every admission while owner-funded credentials remain isolated',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-provider-suspension-'));
 const prices={inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true};
 const api={baseUrl:'https://provider.example.invalid/v1',apiKey:'fixture-platform-key',model:'fixture-model'};
 const cfg={api,allow:{groups:['123']},productionBudget:{enabled:true,endpoint:api.baseUrl,model:api.model,prices,defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:123':{mode:'platform',enabled:true}},outputCap:128,platformSuspended:true}};
 const storage=createPaidCallStorage(path.join(dir,'paid.sqlite')),guard=createPaidCallGuard({storage,config:()=>cfg});
 t.after(()=>{setPaidCallFundingServices(null);storage.close();assert.ok(dir.startsWith(path.join(os.tmpdir(),'qq-provider-suspension-')));fs.rmSync(dir,{recursive:true,force:true});});
 const context=source=>({botId:'primary',conversationKey:'group:123',actorId:'fixture',fundingRef:{id:source,version:1},personaRef:{id:'fixture-persona',version:1},requestId:crypto.randomUUID()});
 const prepare=chosen=>guard.prepare({api:chosen,platformCredential:api.apiKey,body:{model:api.model,stream:false,messages:[{role:'user',content:'fixture'}]}});
 runWithConversationContext(context('platform'),()=>assert.throws(()=>prepare(api),{code:'PAID_CALL_DENIED'}));
 assert.equal(guard.records().length,0);
 cfg.productionBudget.platformSuspended=false;
 runWithConversationContext(context('platform'),()=>{const hold=prepare(api);cfg.productionBudget.platformSuspended=true;assert.throws(()=>guard.dispatch(hold),{code:'PAID_CALL_DENIED'});guard.release(hold);});
 const ownerApi={...api,apiKey:'fixture-owner-private-key'};
 setPaidCallFundingServices({resolve:()=>({id:'fixture-owner',version:1,mode:'byok',ownerId:'fixture-owner-id',endpoint:api.baseUrl,model:api.model,prices,apiKey:ownerApi.apiKey,scopeAuthorized:true}),policy:()=>({})});
 runWithConversationContext(context('fixture-owner'),()=>{assert.throws(()=>prepare(api),{code:'PAID_CALL_DENIED'});const hold=prepare(ownerApi);guard.dispatch(hold);guard.complete(hold,{text:JSON.stringify({model:api.model,usage:{prompt_tokens:10,completion_tokens:2,total_tokens:12}})});});
 assert.ok(guard.records().every(row=>row.state!=='unknown'));
});
