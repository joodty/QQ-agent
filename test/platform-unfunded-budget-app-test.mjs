import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';

test('administrator presets budgets for known unfunded chats without creating payment authority',async t=>{
 const root=makeDataDir('qq-unfunded-budget-app-'),publicOrigin='https://budgets.example.test',ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready();
 const token='fixture-unfunded-budget-internal-token';
 writeConfig(root,{platform:{enabled:true,publicOrigin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-unfunded-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:[],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{},outputCap:512,imageTokensPerImage:1024}});
 const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),paid=await import('../src/paid-call-guard.js');let app,gateway;
 t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();paid.closeProductionPaidCallGuard();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));assert.ok(root.startsWith(path.join(path.dirname(root),'qq-unfunded-budget-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){}});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});const port=await app.start();await waitFor(()=>app.onebot.connected,10000,'mock OneBot connected');
 gateway=createAdminGateway({publicOrigin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${port}`,consoleToken:token});await gateway.listen(await freePort());
 const request=(method,route,body,cookie='')=>new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(publicOrigin).host,origin:publicOrigin,cookie,...(body?{'content-type':'application/json'}:{})}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(raw),cookie:res.headers['set-cookie']?.[0]?.split(';')[0]}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
 const admin=(await request('POST','/api/auth/login',{username:'fixture_admin',password:'fixture-admin-pass-2026'})).cookie,user=(await request('POST','/api/auth/register',{username:'fixture_user',password:'fixture-user-pass-2026'})).cookie;
 const budgets=()=>request('GET','/api/platform/budgets',null,admin),save=(version,overrides,cookie=admin)=>request('PUT','/api/platform/budgets',{version,overrides},cookie);

 await t.test('a new whitelist private chat and same-number group save independently before any conversation or funding exists',async()=>{
  assert.equal((await request('POST','/api/config',{allow:{groups:['606'],private:['999','606']}},admin)).status,200);
  const listed=(await request('GET','/api/platform/overview?summary=1',null,admin)).data.scopes;
  for(const key of ['group:606','private:606'])assert.ok(listed.some(row=>row.chatKey===key));
  const before=(await budgets()).data,first=await save(before.version,{'private:606':.2});assert.equal(first.status,200);
  assert.equal(first.data.conversations.find(row=>row.key==='private:606'||row.chatKey==='private:606').dailyLimitCny,.2);
  assert.equal((await save(before.version,{'group:606':.8})).status,409);
  assert.equal((await save(first.data.version,{'group:606':.8})).status,200);
  const cfg=app.getConfig();assert.equal(cfg.productionBudget.overrides['private:606'],.2);assert.equal(cfg.productionBudget.overrides['group:606'],.8);assert.deepEqual(cfg.productionBudget.funding,{});
  for(const key of ['group:606','private:606']){assert.equal(app.platformBusiness.runtimeAllowed(key),false);assert.throws(()=>paid.runWithPaidConversation(key,()=>{throw Error('A paid call must not be admitted');}),/聊天或出资未获明确授权/);}
  assert.equal(app.store.chats.size,0);assert.deepEqual(app.store.archives.list(),[]);assert.equal(paid.productionPaidCallGuard().records().length,0);assert.equal(ob.state.sends.length,0);
 });
 await t.test('ordinary accounts cannot use the administrator patch and unknown or malformed targets leave configuration unchanged',async()=>{
  const version=(await budgets()).data.version,snapshot=JSON.stringify(app.getConfig().productionBudget);
  assert.equal((await save(version,{'private:606':9},user)).status,403);
  assert.equal((await request('PUT','/api/platform/budgets',{chatKey:'private:606',dailyLimitCny:9},user)).status,403);
  for(const key of ['private:707','private:0606','606','group:bad'])assert.equal((await save(version,{[key]:9})).status,400);
  assert.equal(JSON.stringify(app.getConfig().productionBudget),snapshot);
  const ordinary=(await request('GET','/api/platform/overview?summary=1',null,user)).data;assert.ok(!ordinary.scopes.some(row=>['group:606','private:606'].includes(row.chatKey)));
 });
 await t.test('history-only and explicitly disabled funded resources can be preset without restoring payment, and native limits stay narrow',async()=>{
  app.store.appendIncoming('private:808',{mid:1,ts:Date.now(),senderId:'808',senderName:'Fixture historical caller',text:'Fixture saved history'});
  app.updateConfig({productionBudget:{funding:{'private:606':{mode:'platform',enabled:false}}}});
  let current=(await budgets()).data;assert.equal((await save(current.version,{'private:808':.4,'private:606':.3})).status,200);
  assert.equal(app.platformBusiness.runtimeAllowed('private:808'),false);assert.equal(app.platformBusiness.runtimeAllowed('private:606'),false);assert.equal(app.getConfig().productionBudget.funding['private:606'].enabled,false);
  current=(await budgets()).data;assert.throws(()=>paid.updateProductionBudgetLimits({version:current.version,overrides:{'private:808':.5}}),/只能设置已有授权聊天/);
  assert.equal((await save(current.version,{'private:808':null})).status,200);assert.equal(app.getConfig().productionBudget.overrides['private:808'],undefined);assert.equal(app.getConfig().productionBudget.overrides['group:606'],.8);
  assert.equal(paid.productionPaidCallGuard().records().length,0);assert.equal(ob.state.sends.length,0);
 });
});
