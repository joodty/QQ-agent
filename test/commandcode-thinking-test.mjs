import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectDialect, resolveThinkingRequest, buildThinkingParams, thinkingEffortOptions } from '../src/thinking.js';
import { buildCommandCodeRequest } from '../src/commandcode-transport.js';

const endpoint='https://api.commandcode.ai/alpha',deepseek='deepseek/deepseek-v4.1-flash',glm='z-ai/glm-5.3-flash';
test('only the exact native alpha endpoint takes priority over model-name reasoning dialects',()=>{
 for(const model of [deepseek,glm])assert.equal(detectDialect({baseUrl:endpoint,model}).dialect,'commandcode');
 assert.equal(detectDialect({baseUrl:endpoint+'/',model:glm}).dialect,'commandcode');
 for(const baseUrl of ['https://api.commandcode.ai/provider/v1','https://api.commandcode.ai/alpha/generate','https://api.commandcode.ai/alpha?extra=1','https://api.commandcode.ai/alpha#fragment','https://api.commandcode.ai:8443/alpha','https://api.commandcode.ai.example.invalid/alpha','https://other.example.invalid/alpha','http://api.commandcode.ai/alpha'])assert.notEqual(detectDialect({baseUrl,model:glm}).dialect,'commandcode');
 assert.equal(detectDialect({baseUrl:'https://openrouter.ai/api/v1',model:'anthropic/claude-fixture'}).dialect,'openrouter');
});
test('official CLI model capabilities do not manufacture medium/xhigh/off settings',()=>{
 assert.deepEqual(thinkingEffortOptions({baseUrl:endpoint,model:deepseek}),['','low','high','max']);assert.deepEqual(thinkingEffortOptions({baseUrl:endpoint,model:glm}),['','low','high','max']);
 assert.deepEqual(thinkingEffortOptions({baseUrl:endpoint,model:'deepseek/deepseek-v4-flash'}),['','high','max']);assert.deepEqual(thinkingEffortOptions({baseUrl:endpoint,model:'unknown-next-model'}),['']);
 for(const effort of ['low','high','max']){
  const resolved=resolveThinkingRequest({baseUrl:endpoint,model:glm,thinkingEffort:effort}),built=buildThinkingParams(resolved);
  assert.deepEqual(built.params,{reasoning_effort:effort});assert.equal(built.applied,true);assert.equal(built.omitTemperature,false);
  const wire=buildCommandCodeRequest({api:{baseUrl:endpoint,model:glm,transport:'commandcode-generate',apiKey:'fixture-thinking-key'},body:{model:glm,messages:[{role:'user',content:'Fixture thinking request'}],stream:false,max_tokens:16,...built.params}});
  assert.equal(wire.body.params.reasoning_effort,effort);assert.equal(wire.body.params.max_tokens,16);
 }
 for(const effort of ['medium','xhigh'])assert.throws(()=>buildThinkingParams(resolveThinkingRequest({baseUrl:endpoint,model:glm,thinkingEffort:effort})),{code:'COMMANDCODE_UNSUPPORTED_REASONING'});
 const off=buildThinkingParams(resolveThinkingRequest({baseUrl:endpoint,model:glm,thinkingEffort:'off'}));assert.deepEqual(off.params,{});assert.equal(off.applied,false);
 const defaults=buildThinkingParams(resolveThinkingRequest({baseUrl:endpoint,model:glm,thinkingEffort:'',thinkingMode:'auto'}));assert.deepEqual(defaults.params,{});assert.equal(defaults.applied,false);
});
test('generic providers and existing direct-provider dialects keep their old request conventions',()=>{
 assert.deepEqual(buildThinkingParams(resolveThinkingRequest({baseUrl:'https://api.deepseek.com',model:'deepseek-fixture',thinkingEffort:'high'})).params,{thinking:{type:'enabled'}});
 assert.deepEqual(buildThinkingParams(resolveThinkingRequest({baseUrl:'https://models.example.invalid/v1',model:'unknown-model',thinkingEffort:'high'})).params,{});
});

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-commandcode-thinking-'));process.env.QQ_AGENT_DATA_DIR=root;
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js'),{chatCompletion}=await import('../src/llm.js'),paid=await import('../src/paid-call-guard.js'),{createPlatformModelManagement}=await import('../src/platform-management-model.js');
test.after(()=>{paid.closeProductionPaidCallGuard();paid.setPaidCallFundingServices(null);assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-commandcode-thinking-')));fs.rmSync(root,{recursive:true,force:true});});
test('saving default thinking applies on the next original guarded native model request',async t=>{
 const prices={inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true};
 setRuntimeConfig({...structuredClone(DEFAULT_CONFIG),api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:endpoint,model:glm,apiKey:'fixture-live-thinking-key',thinkingEffort:'high',thinkingMode:'auto'},allow:{groups:['123'],private:[]},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint,model:glm,prices,totalDailyLimitCny:3,defaultDailyLimitCny:1.5,overrides:{},initialSpent:{},funding:{'group:123':{mode:'platform',enabled:true}},outputCap:32,imageTokensPerImage:1024,approvedProviders:[{endpoint,model:deepseek,prices,imageTokensPerImage:1024}]}});
 const requests=[],native=globalThis.fetch;
 globalThis.fetch=async(url,options)=>{assert.equal(String(url),endpoint+'/generate');requests.push(JSON.parse(options.body));return new Response([{type:'text-start',id:'t'},{type:'text-delta',id:'t',text:'Fixture response'},{type:'text-end',id:'t'},{type:'finish',finishReason:'stop',totalUsage:{inputTokens:10,outputTokens:2,totalTokens:12}}].map(event=>JSON.stringify(event)).join('\n')+'\n',{status:200});};
 t.after(()=>{globalThis.fetch=native;paid.closeProductionPaidCallGuard();});
 const admin={id:'fixture-admin',role:'admin'},user={id:'fixture-user',role:'user'};
 const service=createPlatformModelManagement({auth:{verifyPrincipal(principal){return principal;}},providers:()=>{const current=getConfig().productionBudget;return [{endpoint:current.endpoint,model:current.model,prices:current.prices},...current.approvedProviders];}});
 await paid.runWithPaidConversation('group:123',()=>chatCompletion({messages:[{role:'user',content:'Fixture first'}],maxTokens:16}));assert.equal(requests.at(-1).params.reasoning_effort,'high');
 const before=service.get(admin);assert.throws(()=>service.update(user,{expectedVersion:before.version,endpoint,model:glm,thinkingEffort:'max'}),e=>e.statusCode===403);
 const changed=service.update(admin,{expectedVersion:before.version,endpoint,model:glm,thinkingEffort:'max',apiKey:''});assert.equal(changed.thinkingEffort,'max');assert.notEqual(changed.version,before.version);
 await paid.runWithPaidConversation('group:123',()=>chatCompletion({messages:[{role:'user',content:'Fixture second'}],maxTokens:16}));assert.equal(requests.at(-1).params.reasoning_effort,'max');assert.equal(requests.at(-1).params.max_tokens,16);assert.equal(requests.length,2);
 const records=paid.productionPaidCallGuard().records({key:'group:123'});assert.equal(records.length,2);assert.ok(records.every(row=>row.state==='settled'));
 assert.doesNotMatch(JSON.stringify(changed),/fixture-live-thinking-key|apiKey/);
});
