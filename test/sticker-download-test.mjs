import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createStickerDownloader,downloadStickerImage} from '../src/sticker-download.js';
test('default download policy rejects local/file/credential URLs before any image request',async()=>{
 for(const url of ['file:///etc/passwd','http://127.0.0.1/a','http://169.254.169.254/a','https://user:pass@example.test/a'])await assert.rejects(downloadStickerImage(url));
});
test('redirect bodies are destroyed, every hop is validated, and body size/total timeout/cancellation remain bounded',async t=>{
 const paths=[],redirectClosed=new Promise(resolve=>{t.redirectClosed=resolve;});
 const server=http.createServer((req,res)=>{paths.push(req.url);if(req.url==='/redirect'){res.writeHead(302,{location:'/final'});res.write('ongoing');const interval=setInterval(()=>res.write('never-ending'),5);res.on('close',()=>{clearInterval(interval);t.redirectClosed();});return;}if(req.url==='/private'){res.writeHead(302,{location:'http://127.0.0.1/private'});res.end();return;}if(req.url==='/slow'){res.writeHead(200);res.write('a');return;}if(req.url==='/large'){res.writeHead(200);res.end(Buffer.alloc(100));return;}res.writeHead(200);res.end('fixture');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const resolve=async(raw,opts)=>{const url=new URL(raw);assert.equal(opts.allowPrivate,false);if(url.hostname!=='fixture.example.test')throw Error('blocked host');return {url,ip:'127.0.0.1'};};
 const download=createStickerDownloader({resolve}),base='http://fixture.example.test:'+server.address().port;
 assert.equal((await download(base+'/redirect')).toString(),'fixture');await Promise.race([redirectClosed,new Promise((_,reject)=>setTimeout(()=>reject(Error('redirect socket remained open')),500))]);
 assert.deepEqual(paths,['/redirect','/final']);await assert.rejects(download(base+'/private'));assert.equal(paths.filter(p=>p==='/private').length,1);
 await assert.rejects(download(base+'/large',{maxBytes:12}),{code:'STICKER_IMAGE_TOO_LARGE'});
 const at=Date.now();await assert.rejects(download(base+'/slow',{timeoutMs:100}),{code:'STICKER_DOWNLOAD_CANCELLED'});assert.ok(Date.now()-at<1000);
 const stop=new AbortController();const pending=download(base+'/slow',{signal:stop.signal});stop.abort();await assert.rejects(pending,{code:'STICKER_DOWNLOAD_CANCELLED'});
});
