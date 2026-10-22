import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPlatformStore} from '../src/platform-store.js';
import {ConversationArchives} from '../src/conversation-archives.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-agent-business-cli-'));
test.after(()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'qq-agent-business-cli-')));fs.rmSync(root,{recursive:true,force:true});});
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(args){return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[fileURLToPath(new URL('../scripts/import-platform-business.mjs',import.meta.url)),...args],{windowsHide:true});let out='',err='';p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>err+=s);p.on('error',reject);p.on('exit',code=>resolve({code,out,err}));});}
test('business CLI defaults to isolated preview, applies privately and does not replace the paid ledger or expose keys',async()=>{
  const data=path.join(root,'data');fs.mkdirSync(data);const userId='a'.repeat(32),stamp=Date.now();
  const auth=createPlatformStore({file:path.join(data,'platform.sqlite')});auth.importBundle({format:'qq-agent-platform-accounts',version:1,sourceId:'fixture-accounts',auth:{version:1,users:[{id:userId,username:'fixture-admin',role:'admin',disabled:false,conversationKeys:[],botScopes:[],password:{algorithm:'scrypt-v1',salt:'1'.repeat(32),key:'2'.repeat(128)},passwordVersion:1,createdAt:stamp,updatedAt:stamp}],sessions:[]},bindings:[],challenges:[],delegations:[],conversations:[]},{dryRun:false});auth.close();
  const archives=new ConversationArchives({file:path.join(data,'conversation-archives.sqlite')});archives.importBundle({format:'qq-bridge-archives',version:1,sourceId:'fixture-source',personas:[],archives:[],selected:[],coverage:{status:'partial'}},{dryRun:false});archives.close();
  const cfg={api:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-platform-key'},allow:{groups:[],private:[]},productionBudget:{enabled:true,endpoint:'https://api.deepseek.com',model:'deepseek-flash',prices:{inputCnyPerMillion:2,cacheHitCnyPerMillion:.04,outputCnyPerMillion:8,reasoningIncluded:true},defaultDailyLimitCny:1,overrides:{},initialSpent:{},outputCap:1024,imageTokensPerImage:1024,funding:{}}};fs.writeFileSync(path.join(data,'config.json'),JSON.stringify(cfg),{mode:0o600});
  const input=path.join(root,'private-input.json');fs.writeFileSync(input,JSON.stringify({format:'qq-bridge-business',version:1,sourceId:'fixture-source',credentials:[{id:'fixture-profile',ownerId:userId,name:'Fixture profile',endpoint:'https://api.deepseek.com',model:'deepseek-flash',apiKey:'fixture-private-key-sentinel',enabled:true,version:1}],funding:[],usage:[]}),{mode:0o600});
  const args=['--data-dir',data,'--input',input,'--public-origin','https://console.example.test:8445'];const before=new Map(['platform.sqlite','conversation-archives.sqlite','config.json'].map(name=>[name,digest(path.join(data,name))]));
  const preview=await run(args);assert.equal(preview.code,0,preview.err);assert.equal(JSON.parse(preview.out).dryRun,true);assert.equal(fs.existsSync(path.join(data,'platform-business.sqlite')),false);assert.equal(fs.existsSync(path.join(data,'platform-business.key')),false);
  for(const [name,hash]of before)assert.equal(digest(path.join(data,name)),hash);
  const applied=await run([...args,'--apply']);assert.equal(applied.code,0,applied.err);assert.equal(JSON.parse(applied.out).profilesMapped,1);assert.equal(fs.existsSync(path.join(data,'paid-calls.sqlite')),false);
  assert.equal((preview.out+preview.err+applied.out+applied.err).includes('fixture-private-key-sentinel'),false);
  const repeated=await run([...args,'--apply']);assert.equal(repeated.code,0,repeated.err);assert.equal(JSON.parse(repeated.out).unchanged,1);
});
