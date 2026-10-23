import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {acceptsGzip,COMPRESSION_BODY_LIMIT} from '../src/http-response-compression.js';
import {contentHash,etagMatches} from '../src/http-public-assets.js';
import {TENCENT_SPEECH_VOICE_CATALOGUE_PUBLIC as catalogue,TENCENT_SPEECH_VOICES} from '../src/speech-voices.js';
import {makeDataDir,writeConfig,freePort,listen,waitFor,createMockOneBotHttp,createMockOneBotWs} from './_harness.mjs';

test('compression negotiation honors explicit q=0 and conditional validators use weak comparison',()=>{
  for(const header of ['gzip','br, gzip;q=0.5','*;q=1','GZIP; Q=1.000'])assert.equal(acceptsGzip(header),true,header);
  for(const header of [undefined,'','br','gzip;q=0','gzip;q=0, *;q=1','gzip;q=1, gzip;q=0','gzip;q=bogus','gzip;q=1.1','*;q=0'])assert.equal(acceptsGzip(header),false,String(header));
  assert.ok(etagMatches('"other", W/"abc"','"abc"'));assert.ok(etagMatches('*','"abc"'));assert.ok(!etagMatches('"abcd"','"abc"'));
});

test('real application and gateway serve hashed public assets, bounded gzip and private no-store',async t=>{
  const root=makeDataDir('qq-public-assets-'),origin='https://assets.example.test',nativeFetch=globalThis.fetch;
  const ob=createMockOneBotHttp(),ws=createMockOneBotWs(),obPort=await listen(ob.server),wsPort=await ws.ready();
  globalThis.fetch=(input,options)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(Error('Fixture blocks external network'));return nativeFetch(input,options);};
  const token='fixture-public-assets-console-token';
  writeConfig(root,{platform:{enabled:true,publicOrigin:origin},ownerQQ:'999',api:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-assets-model-key',model:'deepseek-flash',vision:false},snowluma:{autoLaunch:false,dir:'',wsUrl:`ws://127.0.0.1:${wsPort}`,httpUrl:`http://127.0.0.1:${obPort}`},server:{port:await freePort(),token},allow:{groups:['456'],private:['999']},deny:{groups:[],private:[]},allowAllWhenEmpty:false,proactive:{enabled:false},memory:{consolidateEnabled:false},sticker:{enabled:false,collectEnabled:false},webSearch:{enabled:false},extensions:{hotReload:false},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},funding:{'group:456':{mode:'platform',enabled:true}},outputCap:512,imageTokensPerImage:1024}});
  const {createApp}=await import('../src/app.js'),{createAdminGateway}=await import('../src/admin-gateway.js'),{closeProductionPaidCallGuard}=await import('../src/paid-call-guard.js');
  let app,gateway;
  t.after(async()=>{if(gateway)await gateway.close();if(app)await app.stop();closeProductionPaidCallGuard();await ws.close();ob.server.closeAllConnections?.();await new Promise(resolve=>ob.server.close(resolve));globalThis.fetch=nativeFetch;assert.ok(root.startsWith(path.join(path.dirname(root),'qq-public-assets-')));fs.rmSync(root,{recursive:true,force:true});});
  app=createApp({log(){}});await app.platformAuth.bootstrap({username:'fixture_admin',password:'fixture-admin-pass-2026'});const appPort=await app.start();await waitFor(()=>app.onebot.connected,10000);
  gateway=createAdminGateway({publicOrigin:origin,platformFile:path.join(root,'platform.sqlite'),targetOrigin:`http://127.0.0.1:${appPort}`,consoleToken:token});await gateway.listen(0);
  const request=(route,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:gateway.server.address().port,path:route,method,headers:{host:new URL(origin).host,origin,...headers,...(body?{'content-type':'application/json'}:{})}},res=>{const chunks=[];res.on('data',part=>chunks.push(part));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);});
  await t.test('HTML revalidates and refers to content-versioned JS and CSS without caching account data',async()=>{
    const page=await request('/workspace.html',{headers:{'accept-encoding':'gzip'}});assert.equal(page.status,200);assert.equal(page.headers['cache-control'],'no-cache');assert.equal(page.headers['content-encoding'],'gzip');
    const html=gunzipSync(page.body).toString();const js=html.match(/src="(\/platform\.js\?v=[a-f0-9]{64})"/)?.[1],css=html.match(/href="(\/platform\.css\?v=[a-f0-9]{64})"/)?.[1];assert.ok(js);assert.ok(css);
    for(const url of [js,css]){const result=await request(url,{headers:{'accept-encoding':'gzip'}});assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'public, max-age=31536000, immutable');assert.equal(result.headers['content-encoding'],'gzip');const bytes=gunzipSync(result.body);assert.equal(contentHash(bytes),new URL(url,origin).searchParams.get('v'));assert.equal(Number(result.headers['content-length']),result.body.length);assert.match(result.headers.vary,/Accept-Encoding/);}
    const unchanged=await request('/workspace.html',{headers:{'if-none-match':page.headers.etag,'accept-encoding':'gzip'}});assert.equal(unchanged.status,304);assert.equal(unchanged.body.length,0);assert.equal(unchanged.headers['cache-control'],'no-cache');assert.equal(unchanged.headers['content-length'],undefined);assert.equal(unchanged.headers.etag,page.headers.etag);assert.match(unchanged.headers.vary,/Accept-Encoding/);
  });
  await t.test('unversioned assets revalidate while wrong hashes never gain immutable caching',async()=>{
    const first=await request('/platform.js',{headers:{'accept-encoding':'gzip;q=0'}});assert.equal(first.status,200);assert.equal(first.headers['cache-control'],'no-cache');assert.equal(first.headers['content-encoding'],undefined);assert.equal(Number(first.headers['content-length']),first.body.length);
    const second=await request('/platform.js',{headers:{'if-none-match':first.headers.etag}});assert.equal(second.status,304);assert.equal(second.body.length,0);
    for(const suffix of ['?v='+'0'.repeat(64),'?v=bad','?v='+contentHash(first.body)+'&v='+contentHash(first.body)]){const bad=await request('/platform.js'+suffix);assert.equal(bad.status,404);assert.doesNotMatch(bad.headers['cache-control'],/immutable/);}
    const head=await request('/platform.js',{method:'HEAD',headers:{'accept-encoding':'gzip'}});assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers['content-encoding'],undefined);assert.equal(head.headers['content-length'],undefined);assert.equal(head.headers.etag,first.headers.etag);assert.match(head.headers.vary,/Accept-Encoding/);
    const identityHead=await request('/platform.js',{method:'HEAD',headers:{'accept-encoding':'gzip;q=0'}});assert.equal(Number(identityHead.headers['content-length']),first.body.length);
  });
  await t.test('only the exact public catalogue hash serves credential-free immutable data and HEAD/304',async()=>{
    const result=await request(catalogue.url,{headers:{'accept-encoding':'gzip'}});assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'public, max-age=31536000, immutable');assert.equal(result.headers['content-encoding'],'gzip');const value=JSON.parse(gunzipSync(result.body));assert.equal(value.version,catalogue.version);assert.equal(value.voices.length,60);assert.deepEqual(value.voices,TENCENT_SPEECH_VOICES);assert.doesNotMatch(JSON.stringify(value),/secretKey|sessionHash|accountId|credentialRef/);
    const head=await request(catalogue.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body.length,0);
    const cached=await request(catalogue.url,{headers:{'if-none-match':result.headers.etag}});assert.equal(cached.status,304);assert.equal(cached.body.length,0);
    for(const url of ['/assets/speech-voices.'+'0'.repeat(64)+'.json',catalogue.url+'?v=bad'])assert.equal((await request(url)).status,404);
    for(const url of ['/assets/%2e%2e/config.json','/%252e%252e/config.json','/assets%5cspeech-voices.'+catalogue.version+'.json'])assert.ok([400,401,403,404].includes((await request(url)).status));
  });
  await t.test('account JSON, auth cookies and unauthorized APIs remain private and uncached',async()=>{
    const auth=await request('/api/auth/login',{method:'POST',body:{username:'fixture_admin',password:'fixture-admin-pass-2026'}});assert.equal(auth.status,200);const cookie=auth.headers['set-cookie'][0].split(';')[0];assert.equal(auth.headers['cache-control'],'no-store');
    const account=await request('/api/platform/credentials',{headers:{cookie,'accept-encoding':'gzip','if-none-match':'*'}});assert.equal(account.status,200);assert.equal(account.headers['cache-control'],'no-store');assert.equal(account.headers.etag,undefined);assert.equal(account.headers['set-cookie'],undefined);
    const anonymous=await request('/api/platform/credentials');assert.equal(anonymous.status,401);assert.equal(anonymous.headers['cache-control'],'no-store');
  });
});

test('gateway gzip never buffers SSE/audio and streams bodies over the bounded compression limit intact',async t=>{
  const {createAdminGateway}=await import('../src/admin-gateway.js');const huge='x'.repeat(COMPRESSION_BODY_LIMIT+65536),origin='https://stream.example.test';
  const target=http.createServer((req,res)=>{
    if(req.url==='/api/events'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: fixture\ndata: '+('x'.repeat(2048))+'\n\n');return;}
    if(req.url==='/platform.css'){res.writeHead(200,{'content-type':'audio/wav'});res.end('x'.repeat(2048));return;}
    if(req.url==='/help.html'){res.writeHead(200,{'content-type':'text/html','cache-control':'public, max-age=31536000, immutable','set-cookie':'fixture=private','etag':'"private"'});res.end('fixture');return;}
    if(req.url==='/workspace.html'){res.writeHead(200,{'content-type':'text/html','cache-control':'public, max-age=31536000, immutable'});res.end('fixture');return;}
    if(req.url==='/api/status'){res.writeHead(200,{'content-type':'application/json','cache-control':'public, max-age=31536000, immutable','etag':'"private"'});res.end(JSON.stringify({fixture:'x'.repeat(4000)}));return;}
    res.writeHead(200,{'content-type':'text/javascript','cache-control':'public, max-age=31536000, immutable'});for(let i=0;i<huge.length;i+=32768)res.write(huge.slice(i,i+32768));res.end();
  });const targetPort=await listen(target),accounts={authenticate:()=>({id:'fixture',role:'admin'}),handleHttp:async()=>false};
  const gateway=createAdminGateway({publicOrigin:origin,platformAuth:accounts,targetOrigin:`http://127.0.0.1:${targetPort}`,consoleToken:'fixture-stream-console-token'});const port=await gateway.listen(0);
  t.after(async()=>{await gateway.close();target.closeAllConnections?.();await new Promise(resolve=>target.close(resolve));});
  const request=route=>new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:route,headers:{host:new URL(origin).host,cookie:'qq_console_session=fixture','accept-encoding':'gzip'}},res=>{const chunks=[];res.on('data',part=>{chunks.push(part);if(route==='/api/events'){resolve({headers:res.headers,body:Buffer.concat(chunks).toString()});res.destroy();}});res.on('end',()=>resolve({headers:res.headers,body:Buffer.concat(chunks).toString(),raw:Buffer.concat(chunks)}));res.on('error',error=>{if(route!=='/api/events')reject(error);});});req.on('error',reject);});
  const big=await request('/platform.js');assert.equal(big.body,huge);assert.equal(big.headers['content-encoding'],undefined);
  const audio=await request('/platform.css');assert.equal(audio.body.length,2048);assert.equal(audio.headers['content-encoding'],undefined);
  const withCookie=await request('/help.html');assert.equal(withCookie.headers['cache-control'],'no-store');assert.equal(withCookie.headers['set-cookie'],undefined);assert.equal(withCookie.headers.etag,undefined);
  const html=await request('/workspace.html');assert.equal(html.headers['cache-control'],'no-cache');
  const api=await request('/api/status');assert.equal(api.headers['cache-control'],'no-store');assert.equal(api.headers.etag,undefined);assert.equal(api.headers['content-encoding'],'gzip');assert.equal(JSON.parse(gunzipSync(api.raw)).fixture.length,4000);
  const events=await request('/api/events');assert.match(events.body,/event: fixture/);assert.equal(events.headers['content-encoding'],undefined);assert.equal(events.headers['cache-control'],'no-store');
});
