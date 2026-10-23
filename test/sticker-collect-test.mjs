// Native scoped collection and real QQ HTTP fallback. No live QQ or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-sticker-collect-'));
process.env.QQ_AGENT_DATA_DIR=root;
const {StickerManager,localStickerPath}=await import('../src/sticker-manager.js');
const {OneBotClient}=await import('../src/onebot.js');
const {SendQueue}=await import('../src/sender.js');
const {setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlZQAAAAASUVORK5CYII=','base64');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('collection stays local and scoped; QQ cache paths and favourites are not implicitly trusted',async t=>{
  setRuntimeConfig({...structuredClone(DEFAULT_CONFIG),send:{...DEFAULT_CONFIG.send,maxPerMinute:1000,maxPerHour:1000}});
  const calls=[],scenario={rejectFile:false,rejectAll:false};
  const server=http.createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    const body=JSON.parse(text),action=req.url.slice(1);calls.push({action,body});
    res.writeHead(200,{'content-type':'application/json'});
    if(action==='get_image')return res.end(JSON.stringify({status:'ok',retcode:0,data:{file:path.join(root,'private.png')}}));
    if(action==='send_group_msg'){
      const ref=body.message.find(s=>s.type==='image')?.data.file||'';
      if(scenario.rejectAll||scenario.rejectFile&&ref.startsWith('file:///'))return res.end(JSON.stringify({status:'failed',retcode:100,wording:'fixture rejected'}));
      return res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:9001}}));
    }
    res.end(JSON.stringify({status:'failed',retcode:404}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const onebot=new OneBotClient({httpUrl:'http://127.0.0.1:'+server.address().port}),manager=new StickerManager(onebot,{download:async()=>png}),view=manager.forChat('group:123');
  t.after(async()=>{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
  let saved;
  await t.test('first collection persists owned bytes, keeps full provenance and never writes QQ favourites',async()=>{
    saved=await view.collect(1,{url:'https://example.test/a.png',note:'fixture note'});
    assert.equal(saved.chatKey,'group:123');assert.equal(saved.botId,'primary');assert.ok(localStickerPath(saved.url,'group:123'));assert.equal(localStickerPath(saved.url,'private:123'),null);
    assert.equal(calls.some(c=>['add_custom_face','modify_custom_face','fetch_custom_face_detail'].includes(c.action)),false);
  });
  await t.test('source idempotency and hash deduplication survive another manager opening the same store',async()=>{
    const again=new StickerManager(onebot,{download:async()=>png});
    const next=await again.forChat('group:123').collect(1,{url:'https://example.test/a.png'});assert.equal(next.id,saved.id);assert.equal((await again.forChat('group:123').list()).total,1);await again.close();
  });
  await t.test('expired images are not pushed to QQ as an unverified server-fetch URL',async()=>{
    manager.library.download=async()=>null;
    await assert.rejects(view.collect(2,{url:'https://example.test/expired.png'}),{code:'STICKER_IMAGE_UNAVAILABLE'});
    assert.equal(calls.some(c=>c.action==='add_custom_face'),false);manager.library.download=async()=>png;
  });
  await t.test('arbitrary get_image filesystem results are not read or silently shared',async()=>{
    fs.writeFileSync(path.join(root,'private.png'),png);manager.library.download=async()=>null;
    await assert.rejects(view.collect(3,{file:'CACHE.png'}),{code:'STICKER_IMAGE_UNAVAILABLE'});manager.library.download=async()=>png;
  });
  await t.test('local file rejection falls back to bounded base64 through the same OneBot queue',async()=>{
    scenario.rejectFile=true;const sender=new SendQueue({onebot,store:{appendSelf(){}}});
    const result=await sender.sendSticker('group:123',saved);assert.equal(result.message_id,9001);
    const sends=calls.filter(c=>c.action==='send_group_msg');assert.equal(sends.length,2);
    assert.ok(sends[0].body.message[0].data.file.startsWith('file:///'));assert.ok(sends[1].body.message[0].data.file.startsWith('base64://'));
    assert.ok(sends.every(s=>s.body.message[0].data.sub_type===1));
  });
  await t.test('both failed formats report failure without cross-scope or direct QQ bypass',async()=>{
    scenario.rejectAll=true;const sender=new SendQueue({onebot,store:{appendSelf(){}}});
    await assert.rejects(sender.sendSticker('group:123',saved),e=>/两种形态都发不出去/.test(e.message)&&/base64=/.test(e.message));
    const before=calls.length;await assert.rejects(sender.sendSticker('private:123',saved),{code:'STICKER_SCOPE_DENIED'});assert.equal(calls.length,before);
  });
});
