import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-image-search-fetch-'));
process.env.QQ_AGENT_DATA_DIR=root;
const originalLookup=dns.promises.lookup,originalRequest=https.request;
let requests=[],reply=()=>({statusCode:200,body:'fixture'});
dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
https.request=(options,callback)=>{
 requests.push(options);const req=new EventEmitter();req.destroy=()=>{};
 req.end=()=>queueMicrotask(()=>{const value=reply(options),body=Buffer.from(value.body||''),chunks=[];for(let i=0;i<body.length;i+=8192)chunks.push(body.subarray(i,i+8192));const res=Readable.from(chunks);res.statusCode=value.statusCode;res.headers=value.headers||{};callback(res);});
 return req;
};
const {getConfig,setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
const {safeFetch}=await import('../src/safe-fetch.js');
const {bingImageSearch,baiduImageSearch}=await import('../src/web-search.js');
test.after(()=>{dns.promises.lookup=originalLookup;https.request=originalRequest;fs.rmSync(root,{recursive:true,force:true});});
test.beforeEach(()=>{requests=[];setRuntimeConfig(structuredClone(DEFAULT_CONFIG));});

test('ordinary text fetch keeps its small default and larger search reads remain explicitly bounded',async()=>{
 reply=()=>({statusCode:200,body:'x'.repeat(180000)});
 const ordinary=await safeFetch('https://fixture.example/page');assert.equal(ordinary.body.length,50000);assert.equal(ordinary.truncated,true);
 const large=await safeFetch('https://fixture.example/page',{maxBytes:1024*1024});assert.equal(large.body.length,180000);assert.equal(large.truncated,false);
 for(const maxBytes of [0,-1,Infinity,'100000',2*1024*1024+1])await assert.rejects(()=>safeFetch('https://fixture.example/page',{maxBytes}),/上限/);
 reply=()=>({statusCode:200,body:'x'.repeat(1200000)});const bounded=await safeFetch('https://fixture.example/page',{maxBytes:1024*1024});assert.equal(bounded.body.length,1024*1024);assert.equal(bounded.truncated,true);
});

test('Bing image results beyond the first 50KB are parsed with an IP-pinned verified TLS request',async()=>{
 const url='https://images.fixture.example/cat.jpg';reply=()=>({statusCode:200,body:'x'.repeat(180000)+'<a m="'+JSON.stringify({murl:url}).replace(/"/g,'&quot;')+'"></a>'});
 assert.deepEqual(await bingImageSearch('fixture cat',{limit:1}),[{title:'fixture cat',url}]);assert.equal(requests[0].hostname,'93.184.216.34');assert.equal(requests[0].servername,'cn.bing.com');assert.equal(requests[0].rejectUnauthorized,true);
});

test('Baidu image results beyond the first 50KB are parsed and deduplicated',async()=>{
 const url='https://images.fixture.example/cat.png';reply=()=>({statusCode:200,body:'x'.repeat(90000)+JSON.stringify({objURL:url,middleURL:url})});
 assert.deepEqual(await baiduImageSearch('fixture cat',{limit:2}),[{title:'fixture cat',url}]);
});

test('larger image-search text reads retain strict private-host, redirect and browse-lock checks',async()=>{
 const config=getConfig();config.security.allowPrivateImageHosts=true;setRuntimeConfig(config);
 await assert.rejects(()=>safeFetch('http://127.0.0.1/private',{maxBytes:1024*1024}));assert.equal(requests.length,0);
 reply=()=>({statusCode:302,headers:{location:'https://127.0.0.1/private'}});await assert.rejects(()=>bingImageSearch('fixture cat'));assert.equal(requests.length,1);
 requests=[];config.security.browseLock={enabled:true,hosts:['cn.bing.com']};setRuntimeConfig(config);
 reply=()=>({statusCode:302,headers:{location:'https://outside.fixture.example/'}});await assert.rejects(()=>bingImageSearch('fixture cat',{browseLocked:true}),/浏览锁定/);assert.equal(requests.length,1);
 requests=[];await assert.rejects(()=>baiduImageSearch('fixture cat',{browseLocked:true}),/浏览锁定/);assert.equal(requests.length,0);
});
