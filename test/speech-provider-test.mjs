import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import crypto from 'node:crypto';
import {createTencentSpeechProvider,quoteSpeechText,signTencentSpeech,validateSpeechCredential,TENCENT_SPEECH,TENCENT_SPEECH_VOICES,validateSpeechVoiceOptions} from '../src/speech-provider.js';

const credentials={format:'qq-agent-tencent-speech-credential',version:1,secretId:'fixtureTencentId',secretKey:'fixture-tencent-secret-value'};
const wav=()=>{const audio=Buffer.alloc(46);audio.write('RIFF');audio.writeUInt32LE(38,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(16000,24);audio.writeUInt32LE(32000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(2,40);return audio;};
async function fixture(t){
  const requests=[],scripts=[];
  const server=http.createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);requests.push({body,headers:req.headers});const plan=scripts.shift()||{};plan.started?.();if(plan.wait)await plan.wait;if(res.destroyed)return;if(plan.hangBody){res.writeHead(200,{'content-type':'application/json'});res.write('{"Response":');return;}res.writeHead(plan.status||200,{'content-type':'application/json',...(plan.headers||{})});res.end(plan.raw??JSON.stringify({Response:{Audio:wav().toString('base64'),SessionId:body.SessionId,RequestId:'fixture-request',...(plan.result||{})}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const provider=createTencentSpeechProvider({now:()=>Date.parse('2026-10-23T04:00:00Z'),fetch(url,options){assert.equal(url,TENCENT_SPEECH.endpoint);assert.equal(options.headers.host,'tts.tencentcloudapi.com');assert.equal(options.redirect,'error');assert.equal(options.method,'POST');assert.equal(options.body.includes(credentials.secretKey),false);return fetch('http://127.0.0.1:'+server.address().port,options);}});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
  return {provider,requests,scripts,call:options=>provider.synthesize({text:'你好，世界。',credentials,beforeRequest(){},...options})};
}

test('official premium quote counts Chinese, letters, punctuation, whitespace and conservatively bounds supplementary characters',()=>{
  const q=quoteSpeechText('你好 A1，\n');assert.equal(q.characters,7);assert.equal(q.amountCny,.00021);assert.equal(q.estimated,true);
  assert.equal(quoteSpeechText('😀').characters,2);assert.equal(quoteSpeechText('中'.repeat(150)).amountCny,.0045);
  for(const text of ['', '   ','<speak>你好</speak>','a\u0000b','\ud800'])assert.throws(()=>quoteSpeechText(text),{code:'SPEECH_TEXT_INVALID'});
  assert.throws(()=>quoteSpeechText('中'.repeat(151)),{code:'SPEECH_TEXT_TOO_LONG'});
  for(const maxChars of [151,0,'120',NaN])assert.throws(()=>quoteSpeechText('你好',{maxChars}),{code:'SPEECH_TEXT_INVALID'});
});

test('TC3 signature binds exact body, fixed host, UTC date and tts service; credentials cannot introduce headers',()=>{
  const signed=signTencentSpeech({text:'你好',credentials,sessionId:'fixture-session',timestamp:1792728000});
  const digest=x=>crypto.createHash('sha256').update(x).digest('hex'),mac=(k,x)=>crypto.createHmac('sha256',k).update(x).digest();
  const canonical=['POST','/','','content-type:application/json; charset=utf-8\nhost:tts.tencentcloudapi.com\n','content-type;host',digest(signed.body)].join('\n');
  const date=new Date(1792728000*1000).toISOString().slice(0,10),scope=date+'/tts/tc3_request';
  const secret=mac(mac(mac('TC3'+credentials.secretKey,date),'tts'),'tc3_request');
  const expected=mac(secret,['TC3-HMAC-SHA256',1792728000,scope,digest(canonical)].join('\n')).toString('hex');
  assert.ok(signed.headers.Authorization.endsWith('Signature='+expected));
  assert.equal(signed.url,'https://tts.tencentcloudapi.com/');assert.equal(signed.headers['X-TC-Action'],'TextToVoice');assert.equal(JSON.parse(signed.body).VoiceType,101001);
  assert.notEqual(signTencentSpeech({text:'你好！',credentials,sessionId:'fixture-session',timestamp:1792728000}).headers.Authorization,signed.headers.Authorization);
  for(const value of [{...credentials,endpoint:'https://example.test'},{...credentials,secretId:'bad\r\nheader'},{...credentials,secretKey:'invalid\nsecret-value'},{...credentials,sessionToken:'bad'}])assert.throws(()=>validateSpeechCredential(value),{code:'SPEECH_CREDENTIAL_INVALID'});
});

test('actual loopback HTTP sends one signed official request and accepts a bounded matching WAV response',async t=>{
  const f=await fixture(t);let admitted=0;const result=await f.call({beforeRequest(){admitted++;}});
  assert.equal(admitted,1);assert.equal(f.requests.length,1);assert.equal(result.mime,'audio/wav');assert.deepEqual(result.audio,wav());assert.equal(result.characters,6);
  assert.match(f.requests[0].headers.authorization,/^TC3-HMAC-SHA256 Credential=fixtureTencentId\//);
  assert.equal(f.requests[0].body.Text,'你好，世界。');assert.equal(f.requests[0].body.Codec,'wav');
});

test('only approved same-price voices and bounded numeric speed/volume are signed and sent',async t=>{
  const f=await fixture(t);assert.equal(TENCENT_SPEECH_VOICES.length,6);assert.deepEqual([...new Set(TENCENT_SPEECH_VOICES.map(v=>v.gender))].sort(),['female','male']);
  for(const voice of TENCENT_SPEECH_VOICES){await f.call({voiceType:voice.voiceType,speed:-.5,volume:2.25});const body=f.requests.at(-1).body;assert.equal(body.VoiceType,voice.voiceType);assert.equal(body.Speed,-.5);assert.equal(body.Volume,2.25);assert.equal(voice.category,'premium');assert.equal(voice.rateCnyPer10k,.3);}
  for(const options of [{voiceType:402000},{voiceType:501000},{voiceType:'101001'},{voiceType:NaN},{speed:3},{speed:-1.01},{speed:NaN},{speed:'1'},{speed:.001},{volume:6},{volume:Infinity},{volume:'0'},{volume:null}]){const before=f.requests.length;assert.throws(()=>validateSpeechVoiceOptions(options),{code:'SPEECH_VOICE_INVALID'});await assert.rejects(f.call(options),{code:'SPEECH_VOICE_INVALID',dispatched:false});assert.equal(f.requests.length,before);}
  const a=signTencentSpeech({text:'你好',credentials,sessionId:'fixture-session',timestamp:1792728000}),b=signTencentSpeech({text:'你好',credentials,sessionId:'fixture-session',timestamp:1792728000,voiceType:101004,speed:.5,volume:1});assert.notEqual(a.headers.Authorization,b.headers.Authorization);
});

test('pre-dispatch cancellation or admission failure never sends; supplier errors are scrubbed and never retried',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();
  await assert.rejects(f.call({signal:controller.signal}),{code:'SPEECH_CANCELLED',dispatched:false});assert.equal(f.requests.length,0);
  await assert.rejects(f.call({beforeRequest(){throw Object.assign(Error('denied'),{code:'fixture-denied'});}}),{code:'fixture-denied'});assert.equal(f.requests.length,0);
  f.scripts.push({status:403,raw:JSON.stringify({error:credentials.secretKey})});
  await assert.rejects(f.call(),e=>e.code==='SPEECH_PROVIDER_REJECTED'&&e.dispatched&&e.chargeOutcome==='unknown'&&!String(e).includes(credentials.secretKey));assert.equal(f.requests.length,1);
});

test('total timeout covers a stalled response body and caller cancellation closes an in-flight request',async t=>{
  const f=await fixture(t);f.scripts.push({hangBody:true});const at=Date.now();await assert.rejects(f.call({timeoutMs:1000}),{code:'SPEECH_TIMEOUT',chargeOutcome:'unknown'});assert.ok(Date.now()-at<2500);assert.equal(f.requests.length,1);
  let started;const began=new Promise(r=>started=r),controller=new AbortController();f.scripts.push({hangBody:true,started});const pending=f.call({signal:controller.signal});await began;controller.abort();await assert.rejects(pending,{code:'SPEECH_CANCELLED',dispatched:true});assert.equal(f.requests.length,2);
});

test('malformed, redirected, oversized or mismatched provider responses fail closed after one attempt each',async t=>{
  const f=await fixture(t);
  const plans=[{status:302,headers:{location:'https://example.test/never'}},{raw:'not-json'},{result:{SessionId:'different-session'}},{result:{Audio:Buffer.alloc(50).toString('base64')}},{headers:{'content-length':String(3*1024*1024)},raw:'{}'},{result:{Error:{Message:credentials.secretKey}}}];
  for(const plan of plans){f.scripts.push(plan);const before=f.requests.length;await assert.rejects(f.call(),e=>e.dispatched&&e.chargeOutcome==='unknown'&&!String(e).includes(credentials.secretKey));assert.equal(f.requests.length,before+1);}
});
