// Trusted ingress only; synthetic OneBot, no image bytes, model or QQ sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs,sleep} from './_harness.mjs';

test('automatic sticker capture receives admitted original events without blocking ingestion',async t=>{
 const root=makeDataDir('qq-sticker-app-'),http=createMockOneBotHttp(),ws=createMockOneBotWs(),nativeFetch=globalThis.fetch;
 const port=await listen(http.server),wsPort=await ws.ready();
 globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Fixture forbids external networking'));
  return nativeFetch(input,options);
 };
 writeConfig(root,{api:{baseUrl:'',apiKey:'',model:'',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${port}`},server:{port:await freePort(),token:'fixture-sticker-control-value'},allow:{groups:['456'],private:['456']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},sticker:{enabled:true,collectEnabled:true,autoCollectEnabled:true}});
 const {createApp}=await import('../src/app.js'),{closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
 let app;
 t.after(async()=>{if(app)await app.stop();await ws.close();http.server.closeAllConnections?.();await new Promise(resolve=>http.server.close(resolve));closeProductionPaidCallGuard();globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-sticker-app-')));fs.rmSync(root,{recursive:true,force:true});});
 app=createApp({log(){}});app.orchestrator.onIncoming=()=>{};
 await app.start();await waitFor(()=>app.onebot.connected&&ws.state.client?.readyState===1,10000,'fixture OneBot connected');
 const captures=[];let release;
 const pending=new Promise(resolve=>{release=resolve;});
 const autoCollect=app.stickers.autoCollect.bind(app.stickers);
 app.stickers.autoCollect=(chatKey,input)=>{captures.push({chatKey,...input});return pending;};
 const image={type:'image',data:{sub_type:1,file:'fixture-image-cache-key',url:'https://example.invalid/fixture.png'}};
 let mid=1000;
 const push=(kind,id,segments,{self=false,post='message'}={})=>ws.push({post_type:post,message_type:kind,...(kind==='group'?{group_id:Number(id)}:{}),user_id:self?888:kind==='private'?Number(id):777,self_id:888,message_id:++mid,time:Math.floor(Date.now()/1000),sender:{user_id:self?888:kind==='private'?Number(id):777,nickname:'Fixture sender'},message:segments});
 await t.test('the same numeric group/private remain distinct and a slow copy does not stall the next event',async()=>{
  push('group','456',[image]);push('private','456',[image]);
  await waitFor(()=>captures.length===2);
  assert.deepEqual(captures.map(row=>row.chatKey),['group:456','private:456']);
  assert.ok(captures.every(row=>row.entry.self===false&&row.entry.mid&&row.segments[0].data.sub_type===1));
  push('group','456',[{type:'text',data:{text:'The next event must enter history while copying is pending.'}}]);
  await waitFor(()=>captures.length===3);assert.equal(app.store.recent('group:456',{limit:10}).length,2);
  assert.equal(http.state.sends.length,0);
 });
 await t.test('unauthorized, denied, self, notices and binding control messages never reach collection',async()=>{
  push('group','999',[image]);push('private','999',[image]);push('group','456',[image],{self:true,post:'message_sent'});
  push('private','456',[{type:'text',data:{text:'绑定 ABCDEFGHIJKL'}}]);
  ws.push({post_type:'notice',notice_type:'notify',sub_type:'poke',group_id:456,user_id:777,target_id:888,self_id:888});
  await sleep(120);assert.equal(captures.length,3);
  app.updateConfig({blocklist:{'456':['777']}});push('group','456',[image]);
  await sleep(80);assert.equal(captures.length,3);
  app.updateConfig({deny:{groups:['456'],private:['456']}});
  push('group','456',[image]);push('private','456',[image]);
  await sleep(100);assert.equal(captures.length,3);assert.deepEqual(app.store.recent('group:999',{limit:10}),[]);assert.deepEqual(app.store.recent('private:999',{limit:10}),[]);
  assert.ok(!http.state.calls.some(action=>['add_custom_face','modify_custom_face','delete_custom_face'].includes(action)));
 });
 await t.test('real app collection saves only declared stickers and isolates an identical group/private number',async()=>{
  release({collected:0,reason:'fixture-complete'});app.stickers.autoCollect=autoCollect;
  app.updateConfig({deny:{groups:[],private:[]},blocklist:{'456':[]}});
  let downloads=0;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZQAAAAASUVORK5CYII=','base64');
  app.stickers.library.download=async()=>{downloads++;return png;};
  push('group','456',[image]);push('private','456',[image]);
  await waitFor(()=>app.stickers.library.load().entries.length===2,5000,'real scoped library saved inbound stickers');await app.stickers.whenIdle();
  const group=app.stickers.forChat('group:456').entries,privateRows=app.stickers.forChat('private:456').entries;
  assert.equal(group.length,1);assert.equal(privateRows.length,1);assert.notEqual(group[0].id,privateRows[0].id);assert.notEqual(group[0].url,privateRows[0].url);
  assert.equal(downloads,2);
  push('group','456',[{...image,data:{...image.data,sub_type:0}}]);
  await waitFor(()=>app.store.recent('group:456',{limit:20}).some(row=>row.mid===mid));await app.stickers.whenIdle();
  assert.equal(downloads,2);assert.equal(app.stickers.library.load().entries.length,2);
  assert.ok(!http.state.calls.some(action=>['add_custom_face','modify_custom_face','delete_custom_face'].includes(action)));assert.equal(http.state.sends.length,0);
 });
 await t.test('shutdown closes the automatic collection queue before retiring the app',async()=>{
  let finish,closed=0;const close=app.stickers.close.bind(app.stickers),before=JSON.parse(fs.readFileSync(path.join(root,'scoped-stickers.json'),'utf8')),files=fs.readdirSync(path.join(root,'sticker-images'),{recursive:true}).sort();
  app.stickers.library.download=()=>new Promise(resolve=>{finish=()=>resolve(Buffer.from('GIF89a'+'fixture-data'));});
  push('group','456',[image]);await waitFor(()=>finish,5000,'fixture asynchronous copy started');
  app.stickers.close=async()=>{closed++;await close();};const stopping=app.stop();finish();await stopping;app=null;
  const after=JSON.parse(fs.readFileSync(path.join(root,'scoped-stickers.json'),'utf8'));
  assert.equal(closed,1);assert.equal(http.state.sends.length,0);assert.deepEqual(after.entries,before.entries);assert.deepEqual(fs.readdirSync(path.join(root,'sticker-images'),{recursive:true}).sort(),files);
  assert.ok(after.collected.length>=before.collected.length); // Failed attempts may still consume the persistent hourly allowance.
 });
});
