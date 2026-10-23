import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-platform-management-model-'));process.env.QQ_AGENT_DATA_DIR=root;
const {createPlatformModelManagement}=await import('../src/platform-management-model.js'),{getConfig,setRuntimeConfig,DEFAULT_CONFIG,CONFIG_FILE,updateConfig}=await import('../src/config.js'),{resolveApiKey,chatCompletion}=await import('../src/llm.js'),paid=await import('../src/paid-call-guard.js');
const prices={inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true};
const expensive={inputCnyPerMillion:4,cacheHitCnyPerMillion:.08,outputCnyPerMillion:16,reasoningIncluded:true};
test.after(()=>{paid.closeProductionPaidCallGuard();paid.setPaidCallFundingServices(null);assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-platform-management-model-')));fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
 paid.closeProductionPaidCallGuard();paid.setPaidCallFundingServices(null);
 const config={...structuredClone(DEFAULT_CONFIG),ownerQQ:'999',api:{...structuredClone(DEFAULT_CONFIG.api),baseUrl:'https://api.deepseek.com',model:'fixture-model-a',provider:'fixture-source',apiKey:'fixture-unused-direct-key'},providers:[{id:'fixture-source',baseURL:'https://api.deepseek.com',models:['fixture-model-a']}],dshProviderKeys:{'fixture-source':'fixture-active-source-key'},allow:{groups:['101'],private:['101']},deny:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'fixture-model-a',prices,defaultDailyLimitCny:1,overrides:{},initialSpent:{},outputCap:1024,imageTokensPerImage:1024,funding:{'group:101':{mode:'platform',enabled:true},'private:101':{mode:'platform',enabled:true}},approvedProviders:[{endpoint:'https://api.deepseek.com',model:'fixture-model-b',prices:expensive,imageTokensPerImage:1024},{endpoint:'https://models.example.test/v1',model:'fixture-model-c',prices,imageTokensPerImage:1024}]}};setRuntimeConfig(config);
 const admin={id:'fixture-admin',role:'admin'},user={id:'fixture-user',role:'user'},auth={verifyPrincipal(p){if(p!==admin&&p!==user)throw Object.assign(Error('fixture invalid login'),{statusCode:401});return p;}};
 const providers=()=>{const cfg=getConfig(),p=cfg.productionBudget;return [{endpoint:p.endpoint,model:p.model,prices:p.prices,responseModels:p.verifiedResponseModels||[],imageTokensPerImage:p.imageTokensPerImage},...p.approvedProviders];};let changed=0;
 return {admin,user,auth,providers,get changed(){return changed;},service:createPlatformModelManagement({auth,providers,onChanged(){changed++;}})};
}
test('platform model view and updates require a fresh real administrator without returning credential values',()=>{
 const f=fixture();assert.throws(()=>f.service.get(f.user),e=>e.statusCode===403);assert.throws(()=>f.service.get({...f.admin}),e=>e.statusCode===401);
 const view=f.service.get(f.admin);assert.equal(view.model,'fixture-model-a');assert.equal(view.hasKey,true);assert.equal(view.providers.length,3);assert.match(view.version,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(view),/fixture-active-source-key|fixture-unused-direct-key|dshProviderKeys|apiKey/);
 assert.throws(()=>f.service.update(f.user,{expectedVersion:view.version}),e=>e.statusCode===403);
});
test('model and effective key update atomically with the budget quote, preserve older BYOK-approved models, and reject stale CAS',()=>{
 const f=fixture(),old=f.service.get(f.admin),before=structuredClone(getConfig());
 const saved=f.service.update(f.admin,{expectedVersion:old.version,endpoint:old.endpoint,model:'fixture-model-b',apiKey:'fixture-new-default-key'});assert.equal(saved.model,'fixture-model-b');assert.equal(saved.hasKey,true);assert.notEqual(saved.version,old.version);
 assert.equal(resolveApiKey(getConfig()),'fixture-new-default-key');assert.equal(getConfig().api.provider,'');assert.deepEqual(getConfig().productionBudget.prices,expensive);assert.equal(getConfig().productionBudget.model,'fixture-model-b');assert.deepEqual(getConfig().productionBudget.funding,before.productionBudget.funding);assert.deepEqual(getConfig().providers,before.providers);assert.deepEqual(getConfig().dshProviderKeys,before.dshProviderKeys);
 assert.ok(saved.providers.some(v=>v.model==='fixture-model-a'));const persisted=JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8'));assert.equal(persisted.api.apiKey,'fixture-new-default-key');assert.equal(persisted.productionBudget.model,'fixture-model-b');
 assert.throws(()=>f.service.update(f.admin,{expectedVersion:old.version,endpoint:old.endpoint,model:old.model,apiKey:'fixture-stale-key'}),e=>e.statusCode===409);assert.equal(resolveApiKey(getConfig()),'fixture-new-default-key');assert.equal(f.changed,1);
 if(process.platform!=='win32')assert.equal(fs.statSync(CONFIG_FILE).mode&0o077,0);
});
test('blank keys preserve only the same endpoint and arbitrary addresses, price fields or masked keys cannot change config',()=>{
 const f=fixture(),old=f.service.get(f.admin);const saved=f.service.update(f.admin,{expectedVersion:old.version,endpoint:old.endpoint,model:'fixture-model-b',apiKey:''});assert.equal(resolveApiKey(getConfig()),'fixture-active-source-key');
 const before=JSON.stringify(getConfig());for(const patch of [{endpoint:'https://unapproved.example.test',model:'fixture-model-a'},{endpoint:'https://models.example.test/v1',model:'fixture-model-c',apiKey:''},{prices:{inputCnyPerMillion:0}},{apiKey:'******'},{apiKey:'bad\nkey'},{apiKey:null}])assert.throws(()=>f.service.update(f.admin,{expectedVersion:saved.version,endpoint:saved.endpoint,model:saved.model,...patch}));assert.equal(JSON.stringify(getConfig()),before);
 const moved=f.service.update(f.admin,{expectedVersion:saved.version,endpoint:'https://models.example.test/v1',model:'fixture-model-c',apiKey:'fixture-new-endpoint-key'});assert.equal(moved.endpoint,'https://models.example.test/v1');assert.equal(resolveApiKey(getConfig()),'fixture-new-endpoint-key');assert.doesNotMatch(JSON.stringify(moved),/fixture-new-endpoint-key|fixture-active-source-key/);
});
test('an unconfigured platform must provide an actual key rather than accepting a browser-only required attribute',()=>{
 const f=fixture();setRuntimeConfig({...getConfig(),api:{...getConfig().api,provider:'',apiKey:''}});const current=f.service.get(f.admin);assert.equal(current.hasKey,false);assert.throws(()=>f.service.update(f.admin,{expectedVersion:current.version,endpoint:current.endpoint,model:current.model,apiKey:''}),e=>e.statusCode===400);assert.equal(resolveApiKey(getConfig()),'');
});
test('failed configuration persistence leaves the original runtime and file unchanged',()=>{
 const f=fixture();updateConfig({api:{temperature:.6}});const before=structuredClone(getConfig()),persisted=fs.readFileSync(CONFIG_FILE),temporary=CONFIG_FILE+'.tmp';fs.mkdirSync(temporary);
 try{assert.throws(()=>f.service.update(f.admin,{expectedVersion:f.service.get(f.admin).version,endpoint:'https://api.deepseek.com',model:'fixture-model-b',apiKey:'fixture-uncommitted-key'}),e=>e.statusCode===503);assert.deepEqual(getConfig(),before);assert.deepEqual(fs.readFileSync(CONFIG_FILE),persisted);}finally{fs.rmdirSync(temporary);}
});
test('the original model HTTP engine immediately uses the saved model/key with the matching paid admission price',async t=>{
 const f=fixture(),requests=[],server=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);requests.push({body,key:req.headers.authorization});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:'fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const native=globalThis.fetch;
 globalThis.fetch=(url,options)=>{assert.equal(String(url),'https://api.deepseek.com/chat/completions');return native('http://127.0.0.1:'+server.address().port,options);};t.after(async()=>{globalThis.fetch=native;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));paid.closeProductionPaidCallGuard();});
 const old=f.service.get(f.admin);f.service.update(f.admin,{expectedVersion:old.version,endpoint:old.endpoint,model:'fixture-model-b',apiKey:'fixture-original-engine-key'});
 await paid.runWithPaidConversation('group:101',()=>chatCompletion({messages:[{role:'user',content:'fixture request'}],maxTokens:1}));assert.equal(requests.length,1);assert.equal(requests[0].body.model,'fixture-model-b');assert.equal(requests[0].key,'Bearer fixture-original-engine-key');assert.equal(paid.productionPaidCallGuard().records({key:'group:101'}).at(-1).state,'settled');
});
