import assert from 'node:assert/strict';
import test from 'node:test';
import {createWorkspaceFixture} from './_platform-workspace-fixture.mjs';

test('administrators manage another person’s private speech through the same scoped HTTP settings and subsidy routes',async t=>{
 const credential={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixture-speech-id',secretKey:'fixture-speech-private-management-secret'};
 const f=await createWorkspaceFixture({admin:true,speechCredentials:()=>credential});t.after(()=>f.close());
 const userCookie=f.auth.cookie((await f.auth.login({username:'fixture_user',password:'fixture-user-pass-2026'})).token).split(';')[0];
 const request=async(method,route,body,cookie=f.cookie)=>{
  const response=await fetch(f.origin+'/api/platform/speech/'+route,{method,headers:{cookie,origin:f.origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json()};
 };
 const settings=(key,cookie=f.cookie)=>request('GET','settings?compact=1&chatKey='+encodeURIComponent(key),null,cookie);
 const grant=(key,expectedVersion,enabled,dailyLimitCny)=>request('PUT','subsidy',{chatKey:key,expectedVersion,enabled,dailyLimitCny,allowedFundingModes:['platform','trial','byok']});
 const save=(key,expectedVersion,enabled,extra={},cookie=f.cookie)=>request('PUT','settings',{chatKey:key,expectedVersion,enabled,...extra},cookie);
 assert.notEqual(f.principal.boundQQ,'999');
 assert.equal((await request('PUT','platform',{expectedVersion:1,enabled:true,dailyLimitCny:1,cooldownMs:1000})).status,200);

 await t.test('missing subsidy is a funding guard rather than an administrator versus private-owner denial',async()=>{
  const before=await settings('private:999');assert.equal(before.status,200);assert.equal(before.data.subsidy.enabled,false);
  const blocked=await save('private:999',0,true);assert.equal(blocked.status,403);assert.equal(blocked.data.error,'管理员尚未为这个聊天开通平台语音额度。');
  assert.equal((await settings('private:999')).data.settings.version,0);
 });
 await t.test('administrator can enable, disable, adjust quota and enforce independent CAS for a non-owned private chat',async()=>{
  assert.equal((await grant('private:999',0,true,.2)).status,200);
  const enabled=await save('private:999',0,true,{maxChars:60,cooldownMs:2000,autoVoicePercent:40});assert.equal(enabled.status,200);assert.equal(enabled.data.settings.enabled,true);assert.equal(enabled.data.settings.autoVoicePercent,40);
  assert.equal((await save('private:999',0,false)).status,409);
  assert.equal((await grant('private:999',0,true,.3)).status,409);
  assert.equal((await grant('private:999',1,true,.3)).status,200);
  assert.equal((await save('private:999',1,false)).status,200);
  const persisted=(await settings('private:999')).data;assert.equal(persisted.settings.enabled,false);assert.equal(persisted.subsidy.dailyLimitCny,.3);assert.equal(persisted.settings.maxChars,60);
 });
 await t.test('ordinary users retain own-private settings but cannot fund speech or manage someone else’s private chat',async()=>{
  assert.equal((await settings('private:999',userCookie)).status,403);
  assert.equal((await save('private:999',2,true,{},userCookie)).status,403);
  assert.equal((await request('PUT','subsidy',{chatKey:'private:999',expectedVersion:2,enabled:true,dailyLimitCny:1,allowedFundingModes:['platform']},userCookie)).status,403);
  assert.equal((await grant('private:777',0,true,.1)).status,200);
  assert.equal((await save('private:777',0,true,{autoVoicePercent:10},userCookie)).status,200);
  assert.equal((await settings('private:777',userCookie)).data.settings.autoVoicePercent,10);
  assert.equal((await request('PUT','subsidy',{chatKey:'private:777',expectedVersion:1,enabled:true,dailyLimitCny:1,allowedFundingModes:['trial']},userCookie)).status,403);
  assert.equal((await settings('private:999')).data.subsidy.dailyLimitCny,.3);
 });
 await t.test('an explicit private-chat grant also permits ordinary settings without granting platform subsidy rights',async()=>{
  const user=f.auth.authenticate(userCookie);f.auth.store.grant(user.id,'private:999');
  assert.equal((await settings('private:999',userCookie)).status,200);
  assert.equal((await save('private:999',2,true,{autoVoicePercent:20},userCookie)).status,200);
  assert.equal((await request('PUT','subsidy',{chatKey:'private:999',expectedVersion:2,enabled:true,dailyLimitCny:2,allowedFundingModes:['platform']},userCookie)).status,403);
  assert.equal((await settings('private:999')).data.subsidy.dailyLimitCny,.3);
 });
 assert.ok(!f.calls.some(call=>/preview|synthesize|test-chat|completions/.test(call.path)));
});
