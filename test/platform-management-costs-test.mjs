import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createPlatformCostSummary} from '../src/platform-management-costs.js';
function fixture(t,{missing=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-management-costs-')),file=path.join(root,'paid.sqlite'),admin={id:'admin',role:'admin'},alice={id:'alice',role:'user'},bob={id:'bob',role:'user'},people=new Set([admin,alice,bob]),permissions=new Map([[admin,new Set(['group:101','private:101','group:202'])],[alice,new Set(['group:101'])],[bob,new Set(['private:101'])]]);
 t.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-management-costs-')));fs.rmSync(root,{recursive:true,force:true});});
 const auth={verifyPrincipal(p){if(!people.has(p))throw Object.assign(Error('fixture invalid login'),{statusCode:401});return p;},listScopes(p){this.verifyPrincipal(p);return [...permissions.get(p)];},canAccess(p,key){return people.has(p)&&permissions.get(p)?.has(key);}};
 const row=(id,chatKey,amount,state='settled',operationId=id,date='2026-10-23')=>({id,key:chatKey,amountMicros:amount,actualMicros:state==='settled'?amount:null,state,operationId,date});
 const records=[row('seed','group:101',500000,'settled','seed:fixture'),row('model-one','group:101',100000),row('speech-one','group:101',10000,'settled','service:speech:one'),row('speech-unknown','group:101',3000,'unknown','service:speech:unknown'),row('model-pending','group:101',2000,'dispatched'),row('model-released','group:101',4000,'released'),row('private-model','private:101',200000),row('foreign-model','group:202',400000),row('historical-speech','group:909',30000,'settled','service:speech:historical'),row('older-model','group:101',777000,'settled','older-model','2026-10-16')];
 const attrs=Object.fromEntries(records.filter(r=>r.operationId.startsWith('service:speech:')).map(r=>[r.id,{key:r.key,kind:'speech'}]));
 if(!missing){const db=new DatabaseSync(file);db.exec('CREATE TABLE paid_documents(name TEXT PRIMARY KEY,body TEXT NOT NULL) STRICT;PRAGMA application_id=0x51425047;PRAGMA user_version=1');const insert=db.prepare('INSERT INTO paid_documents VALUES(?,?)');for(const [name,body]of [['conversation-budget',{version:1,botId:'primary',records}],['call-attribution',attrs],['speech-subsidy-budget',{records}],['speech-platform-budget',{records}],['platform-trial-budget',{records}]])insert.run(name,JSON.stringify(body));db.close();}
 const legacy=[{chatKey:'group:101',date:'2026-10-23',amountMicros:50000}],service=createPlatformCostSummary({file,auth,now:()=>Date.parse('2026-10-22T16:00:01Z'),legacyUsage({from,to,keys}){return legacy.filter(row=>row.date>=from&&row.date<=to&&(!keys||keys.includes(row.chatKey)));}});
 return {file,admin,alice,bob,people,permissions,auth,service};
}
test('authorized totals keep model, speech and legacy distinct while excluding auxiliary ledgers, seeds and released holds',t=>{
 const f=fixture(t),result=f.service.summary(f.alice,{days:7});assert.equal(result.scope,'authorized');assert.equal(result.timezone,'Asia/Shanghai');assert.equal(result.to,'2026-10-23');assert.equal(result.from,'2026-10-17');assert.deepEqual(result.totals,{modelCny:.1,speechCny:.01,legacyCny:.05,totalCny:.16,reservedCny:.005,unknownCny:.003});assert.deepEqual(result.conversations.map(row=>row.chatKey),['group:101']);assert.equal(result.daily.length,1);
 const privateCost=f.service.summary(f.bob,{days:7});assert.equal(privateCost.totals.totalCny,.2);assert.equal(privateCost.totals.speechCny,0);assert.equal(privateCost.conversations[0].chatKey,'private:101');assert.equal(f.service.summary(f.alice,{days:30}).totals.modelCny,.877);
});
test('platform totals are administrator-only and retain historical charged scopes outside live authorization lists',t=>{
 const f=fixture(t);assert.throws(()=>f.service.summary(f.alice,{days:7},true),e=>e.statusCode===403);const authorized=f.service.summary(f.admin,{days:7}),platform=f.service.summary(f.admin,{days:7},true);assert.equal(authorized.totals.totalCny,.76);assert.equal(platform.totals.totalCny,.79);assert.equal(platform.totals.speechCny,.04);assert.equal(platform.conversationCount,4);assert.ok(platform.conversations.some(row=>row.chatKey==='group:909'));
});
test('revocation, missing ledgers and invalid queries do not create storage or invent zero-valued error reports',t=>{
 const f=fixture(t);f.permissions.get(f.alice).clear();assert.equal(f.service.summary(f.alice,{days:7}).totals.totalCny,0);f.people.delete(f.alice);assert.throws(()=>f.service.summary(f.alice,{days:7}),e=>e.statusCode===401);
 for(const input of [{days:1},{days:90},{days:'7'},{chatKey:'group:101'},{days:7,role:'admin'}])assert.throws(()=>f.service.summary(f.admin,input),e=>e.statusCode===400);
 const empty=fixture(t,{missing:true});assert.equal(empty.service.summary(empty.bob,{days:7}).totals.totalCny,0);assert.equal(fs.existsSync(empty.file),false);
});
test('reports preserve every persisted byte and unknown hold; corrupt speech attribution fails closed',t=>{
 const f=fixture(t),before=fs.readFileSync(f.file);for(let i=0;i<3;i++)f.service.summary(f.admin,{days:30},true);assert.deepEqual(fs.readFileSync(f.file),before);
 const db=new DatabaseSync(f.file);db.prepare("UPDATE paid_documents SET body='{}' WHERE name='call-attribution'").run();db.close();assert.throws(()=>f.service.summary(f.alice,{days:7}),e=>e.statusCode===503);
});
test('missing dates or operations, malformed identifiers and zero holds fail before SQL filters can hide the charge',t=>{
 for(const patch of [{date:undefined},{date:'2026-02-30'},{operationId:undefined},{key:'group:001'},{amountMicros:0},{actualMicros:undefined}]){
  const f=fixture(t),db=new DatabaseSync(f.file);const doc=JSON.parse(db.prepare("SELECT body FROM paid_documents WHERE name='conversation-budget'").get().body);Object.assign(doc.records[1],patch);db.prepare("UPDATE paid_documents SET body=? WHERE name='conversation-budget'").run(JSON.stringify(doc));db.close();assert.throws(()=>f.service.summary(f.alice,{days:7}),e=>e.statusCode===503,JSON.stringify(patch));
 }
});
test('authority is checked again after both snapshots so a concurrent revocation cannot return the old chat costs',t=>{
 const f=fixture(t),service=createPlatformCostSummary({file:f.file,auth:f.auth,now:()=>Date.parse('2026-10-22T16:00:01Z'),legacyUsage(){f.permissions.get(f.alice).clear();return [];}});assert.throws(()=>service.summary(f.alice,{days:7}),e=>e.statusCode===403);
 const admin=fixture(t),platform=createPlatformCostSummary({file:admin.file,auth:admin.auth,now:()=>Date.parse('2026-10-22T16:00:01Z'),legacyUsage(){admin.admin.role='user';return [];}});assert.throws(()=>platform.summary(admin.admin,{days:7},true),e=>e.statusCode===403);
});
test('a ten-thousand-row primary ledger aggregates bounded output without loading or returning per-call bodies',t=>{
 const f=fixture(t),db=new DatabaseSync(f.file),records=[],attrs={};
 for(let i=0;i<10000;i++){const id=String(i).padStart(32,'0'),chatKey='group:'+(1000+i%300),speech=i%2===0;records.push({id,key:chatKey,date:'2026-10-23',operationId:(speech?'service:speech:':'model:')+i,amountMicros:1,actualMicros:1,state:'settled'});if(speech)attrs[id]={key:chatKey,kind:'speech'};}
 try{db.prepare("UPDATE paid_documents SET body=? WHERE name='conversation-budget'").run(JSON.stringify({version:1,botId:'primary',records}));db.prepare("UPDATE paid_documents SET body=? WHERE name='call-attribution'").run(JSON.stringify(attrs));}finally{db.close();}
 const result=f.service.summary(f.admin,{days:7},true);assert.equal(result.totals.modelCny,.005);assert.equal(result.totals.speechCny,.005);assert.equal(result.totals.totalCny,.06);assert.equal(result.conversationCount,301);assert.equal(result.conversations.length,200);assert.equal(result.conversationsTruncated,true);assert.ok(JSON.stringify(result).length<80000);assert.equal(result.records,undefined);
});
