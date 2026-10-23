import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-scoped-sticker-'));process.env.QQ_AGENT_DATA_DIR=root;
const {StickerManager,localStickerPath,stickerErrorMessage}=await import('../src/sticker-manager.js');
const {STICKER_LIMITS}=await import('../src/scoped-stickers.js');
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const {SendQueue}=await import('../src/sender.js');
const {OneBotClient}=await import('../src/onebot.js');
const {buildToolDefs}=await import('../src/tools.js');
const {buildStickerContext}=await import('../src/stickers.js');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082','hex');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t){let clock=1_792_728_000_000,allowed=true,downloads=0;const calls=[],folder=fs.mkdtempSync(path.join(root,'case-'));
 setRuntimeConfig({...structuredClone(DEFAULT_CONFIG),api:{...structuredClone(DEFAULT_CONFIG.api),video:false},sticker:{...structuredClone(DEFAULT_CONFIG.sticker),maxCollectPerHour:10},send:{...structuredClone(DEFAULT_CONFIG.send),minGapMs:0,maxGapMs:0,byLengthMs:0,maxPerMinute:1000,maxPerHour:1000}});
 const onebot={async call(action){calls.push(action);return {};},async sendSticker(kind,id,file){calls.push({kind,id,file});return {message_id:7};}};
 const options={dataDir:folder,canUse:()=>allowed,now:()=>clock,download:async()=>{downloads++;return png;}};let manager=new StickerManager(onebot,options);
 t.after(()=>manager.close());return {folder,calls,onebot,get manager(){return manager;},get downloads(){return downloads;},deny(){allowed=false;},allow(){allowed=true;},advance(ms=3600001){clock+=ms;},reopen(){manager=new StickerManager(onebot,options);},view:k=>manager.forChat(k),state:()=>JSON.parse(fs.readFileSync(path.join(folder,'scoped-stickers.json'),'utf8'))};}
const event=(mid=1,subType=1)=>({entry:{mid,self:false,media:[{kind:'image',file:'fixture.png',url:'https://example.test/image.png'}]},segments:[{type:'image',data:{file:'fixture.png',url:'https://example.test/image.png',sub_type:subType}}]});

test('only matching trusted subtype images auto-collect; typed same-number group/private remain isolated',async t=>{
 const f=fixture(t);for(const input of [event(1,0),{...event(1),entry:{...event(1).entry,self:true}},{...event(1),entry:{...event(1).entry,media:[]}}])assert.equal((await f.manager.autoCollect('group:101',input)).collected,0);
 assert.equal(f.downloads,0);await f.manager.autoCollect('group:101',event(11));await f.manager.autoCollect('private:101',event(11));
 const group=(await f.view('group:101').sync()).entries[0],privateEntry=(await f.view('private:101').sync()).entries[0];assert.notEqual(group.id,privateEntry.id);assert.notEqual(group.url,privateEntry.url);
 assert.equal(await f.view('group:101').find(privateEntry.id),null);assert.equal(await f.view('private:101').find(group.id),null);assert.equal((await f.view('group:202').list()).total,0);
 assert.equal(f.view('private:101').note(group.id,{note:'cross-scope overwrite'}),null);assert.equal(f.calls.length,0);
 assert.match(buildStickerContext([group]),/当前聊天独立表情库/);f.reopen();assert.equal((await f.view('private:101').list()).total,1);
});

test('disabled stickers still allow lazy Agent context construction, but every image operation stays disabled',async t=>{
 const f=fixture(t),cfg=getConfig();cfg.sticker.enabled=false;setRuntimeConfig(cfg);const view=f.manager.forChat('group:101');assert.ok(view);await assert.rejects(view.sync(),{code:'STICKER_SCOPE_DENIED'});await assert.rejects(view.collect(1,{url:'https://example.test/x'}),{code:'STICKER_SCOPE_DENIED'});assert.equal(f.downloads,0);
});

test('moving a scoped data directory repairs only its own hashed image path, not a same-number private namespace',async t=>{
 const f=fixture(t),saved=await f.view('group:101').collect(1,{url:'https://example.test/x'}),state=f.state();
 state.entries[0].url='file:///old-deployment/sticker-images/'+path.basename(new URL(saved.url).pathname);fs.writeFileSync(path.join(f.folder,'scoped-stickers.json'),JSON.stringify(state));f.reopen();
 const repaired=await f.view('group:101').ensureSendable(saved);assert.equal(repaired.url,saved.url);assert.ok((await f.view('group:101').image(saved.id)).dataUrl.startsWith('data:image/png;'));await assert.rejects(f.view('private:101').ensureSendable(saved),{code:'STICKER_IMAGE_UNAVAILABLE'});
});

test('legacy favourites and old images are quarantined without any QQ write, sync or filesystem rewrite',async t=>{
 const f=fixture(t),legacy=path.join(root,'stickers.json');fs.writeFileSync(legacy,JSON.stringify([{id:'old',source:'qq',localNote:'private source is unknown',url:'https://example.test/old.png'}]));const raw=fs.readFileSync(legacy);f.reopen();
 assert.deepEqual((await f.manager.sync()).entries,[]);assert.equal((await f.view('group:101').sync()).entries.length,0);assert.throws(()=>f.manager.collect(1,{url:'https://example.test'}),{code:'STICKER_SCOPE_REQUIRED'});
 await f.manager.autoCollect('group:101',event(1));assert.deepEqual(fs.readFileSync(legacy),raw);assert.equal(f.calls.length,0);assert.equal(f.manager.entries.length,0);fs.unlinkSync(legacy);
});

test('source operation and content deduplicate, notes/history never escape scope and clones cannot mutate the store',async t=>{
 const f=fixture(t),view=f.view('group:101');const [one,two]=await Promise.all([view.collect(1,{url:'https://example.test/a'}),view.collect(1,{url:'https://example.test/a'})]);assert.equal(one.id,two.id);assert.equal(f.downloads,1);
 const three=await view.collect(2,{url:'https://example.test/b'});assert.equal(three.id,one.id);assert.equal((await view.list()).total,1);assert.equal(f.state().collected.length,2);
 view.note(one.id,{note:'own note',tags:['own'],usage:'own usage'});view.markUsed(one.id,'private context');const clone=await view.find(one.id);clone.localNote='changed';assert.equal((await view.find(one.id)).localNote,'own note');
 assert.equal((await f.view('private:101').list('own')).matched,0);assert.throws(()=>view.note(one.id,{tags:['x'.repeat(81)]}),{code:'STICKER_NOTE_INVALID'});
});

test('failed downloads consume persisted hourly attempts and restarting does not reopen quota',async t=>{
 const f=fixture(t);f.manager.library.download=async()=>{throw Error('fixture URL failure');};
 for(let i=0;i<10;i++)await assert.rejects(f.view('group:101').collect(i,{url:'https://example.test/bad'}),{code:'STICKER_IMAGE_UNAVAILABLE'});
 assert.equal(f.state().entries.length,0);assert.equal(f.state().collected.length,10);f.reopen();await assert.rejects(f.view('group:101').collect(20,{url:'https://example.test/a'}),{code:'STICKER_RATE_LIMIT'});assert.equal(f.downloads,0);
 f.advance();await f.view('group:101').collect(21,{url:'https://example.test/a'});assert.equal(f.state().entries.length,1);
});

test('bad image/oversize/get_image arbitrary local files are rejected and never promoted into global QQ favourites',async t=>{
 const f=fixture(t),secret=path.join(f.folder,'secret.png');fs.writeFileSync(secret,png);f.onebot.call=async action=>{f.calls.push(action);return {file:secret};};f.manager.library.download=async()=>null;
 await assert.rejects(f.view('group:101').collect(1,{file:'fixture.png'}),{code:'STICKER_IMAGE_UNAVAILABLE'});assert.deepEqual(f.calls,['get_image']);
 f.manager.library.download=async()=>Buffer.from('not an image');await assert.rejects(f.view('group:101').collect(2,{url:'https://example.test/x'}),{code:'STICKER_IMAGE_UNAVAILABLE'});
 f.manager.library.download=async()=>Buffer.concat([png,Buffer.alloc(STICKER_LIMITS.maxImageBytes)]);await assert.rejects(f.view('group:101').collect(3,{url:'https://example.test/x'}),{code:'STICKER_IMAGE_UNAVAILABLE'});assert.equal(f.state().entries.length,0);
});

test('revoking authority or closing while a download awaits keeps only the attempt, no image or published entry',async t=>{
 const f=fixture(t),gate=deferred(),started=deferred();f.manager.library.download=async()=>{started.resolve();return gate.promise;};const pending=f.view('group:101').collect(1,{url:'https://example.test/x'});await started.promise;f.deny();gate.resolve(png);await assert.rejects(pending,{code:'STICKER_SCOPE_DENIED'});assert.equal(f.state().entries.length,0);assert.equal(fs.existsSync(path.join(f.folder,'sticker-images')),false);
 f.allow();const later=deferred(),began=deferred();f.manager.library.download=()=>{began.resolve();return later.promise;};const work=f.view('group:101').collect(2,{url:'https://example.test/x'});await began.promise;await f.manager.close();await assert.rejects(work);later.resolve(png);assert.equal(f.state().entries.length,0);
});

test('one active download and at most four pending prevent parallel floods; the fifth never downloads',async t=>{
 const f=fixture(t),gate=deferred(),started=deferred();let active=0,max=0;f.manager.library.download=async()=>{active++;max=Math.max(max,active);started.resolve();await gate.promise;active--;return png;};
 const queued=[1,2,3,4].map(mid=>f.view('group:101').collect(mid,{url:'https://example.test/x'}));await started.promise;await assert.rejects(f.view('private:101').collect(5,{url:'https://example.test/x'}),{code:'STICKER_BUSY'});gate.resolve();await Promise.all(queued);assert.equal(max,1);assert.equal(f.state().entries.length,1);
});

test('global disk count includes old/orphan media, corruption refuses replacement and private file paths stay inside the owned directory',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.folder,'sticker-images'));for(let i=0;i<200;i++)fs.writeFileSync(path.join(f.folder,'sticker-images',i+'.png'),png);
 await assert.rejects(f.view('group:101').collect(1,{url:'https://example.test/x'}),{code:'STICKER_LIBRARY_FULL'});assert.equal(f.downloads,0);
 const g=fixture(t),file=path.join(g.folder,'scoped-stickers.json');fs.writeFileSync(file,'{broken');await assert.rejects(g.view('group:101').collect(1,{url:'https://example.test/x'}),{code:'STICKER_STORAGE_INVALID'});assert.equal(fs.readFileSync(file,'utf8'),'{broken');assert.equal(localStickerPath(pathToFileURL(path.join(g.folder,'secret.json')).href,'group:101'),null);
});

test('local sticker vision preserves GIF metadata and notes can be read only through the same conversation',async t=>{
 const f=fixture(t),gif=Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b','hex');f.manager.library.download=async()=>gif;const saved=await f.view('group:101').collect(1,{url:'https://example.test/x'});
 const image=await f.view('group:101').image(saved.id);assert.equal(image.isGif,true);assert.deepEqual(image.gifBuffer,gif);assert.ok(image.dataUrl.startsWith('data:image/gif;base64,'));await assert.rejects(f.view('private:101').image(saved.id),{code:'STICKER_IMAGE_UNAVAILABLE'});
});

test('native tools and queue use owned local images, compact QQ subtype and the existing archive/permission guards',async t=>{
 fixture(t);const manager=new StickerManager({}, {download:async()=>png});t.after(()=>manager.close());const view=manager.forChat('group:101'),saved=await view.collect(1,{url:'https://example.test/x',note:'fixture'}),file=await view.image(saved.id);assert.ok(file.dataUrl.startsWith('data:image/png;'));
 const native=new OneBotClient({}),sent=[];native.sendSegments=async(kind,id,segments)=>{sent.push({kind,id,segments});return {message_id:7};};const sender=new SendQueue({onebot:native,store:{appendSelf(){}}});
 const ctx={chatKey:'group:101',stickers:view,sender,session:{triggerText:'fixture',sent:[],id:'fixture'},emit(){}};
 const send=buildToolDefs().find(t=>t.id==='send_sticker');assert.ok(send);const result=await send.execute(ctx,{stickerId:saved.id});assert.equal(result.isError,undefined);assert.equal(sent.length,1);assert.equal(sent[0].segments[0].data.sub_type,1);
 await assert.rejects(sender.sendSticker('private:101',saved),{code:'STICKER_SCOPE_DENIED'});assert.equal(sent.length,1);assert.match(stickerErrorMessage('STICKER_LIBRARY_FULL'),/上限/);
});
