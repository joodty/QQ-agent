import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-speech-runtime-'));
process.env.QQ_AGENT_DATA_DIR=root;
const {setRuntimeConfig,DEFAULT_CONFIG}=await import('../src/config.js');
setRuntimeConfig(structuredClone(DEFAULT_CONFIG));
const {speechToolDefinition:tool,speechWasRequested,createSpeechReplySender}=await import('../src/speech-runtime.js');
const {rescueUnsentReply}=await import('../src/reply-rescue.js');
const {SendQueue}=await import('../src/sender.js');
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
function fixture(chatKey='group:101'){
 const calls={tts:[],voice:[],text:[]},receipt={};let allowed=true,cancelled=false;
 const speech={runtimePolicy:()=>({allowed,settings:{maxChars:120}}),async synthesize(key,input){calls.tts.push({key,input});return {audio:Buffer.from('fixture-audio'),transcript:input.text,receipt};},assertCurrent(value){assert.equal(value,receipt);if(!allowed)throw Object.assign(Error('changed'),{code:'SPEECH_AUTHORIZATION_CHANGED'});}};
 const ctx={chatKey,triggerEntries:[{text:'请用语音回复我',self:false}],proactive:false,session:{id:'fixture-session',sent:[]},toolCallId:'fixture-call',speech,
  assertCurrent(){if(cancelled)throw Object.assign(Error('cancelled'),{code:'SPEECH_CANCELLED'});},
  sender:{async sendMedia(key,segments,options){options.guard?.();calls.voice.push({key,segments,options});return {message_id:1};},async sendTextBatch(key,texts,options){options.guard?.();calls.text.push({key,texts,options});return {sent:texts.map(text=>({text}))};}}};
 return {ctx,calls,speech,setAllowed(value){allowed=value;},cancel(){cancelled=true;}};
}
test('speech demand comes from current human messages, never model args or proactive runs',()=>{
 assert.equal(speechWasRequested([{text:'请用语音回答',self:false}]),true);
 assert.equal(speechWasRequested([{text:'念一下这句话',self:false}]),true);
 assert.equal(speechWasRequested([{text:'不要发语音',self:false}]),false);
 assert.equal(speechWasRequested([{text:'请用语音回答',self:true}]),false);
 assert.equal(speechWasRequested([{text:'请用语音回答'}],{proactive:true}),false);
});
test('group/private and either model payer use the same speech tool and exact resource',async()=>{
 for(const chatKey of ['group:101','private:101'])for(const payer of ['platform','byok']){
  const f=fixture(chatKey);f.ctx.modelPayer=payer;const result=await tool.execute(f.ctx,{text:'晚上好。'});
  assert.ok(!result.isError);assert.equal(f.calls.tts.length,1);assert.equal(f.calls.tts[0].key,chatKey);assert.equal(f.calls.tts[0].input.direct,true);assert.equal(f.calls.voice[0].key,chatKey);
  assert.equal(f.calls.voice[0].segments[0].type,'record');assert.match(f.calls.voice[0].segments[0].data.file,/^base64:\/\//);assert.equal(f.calls.text.length,0);assert.equal(f.ctx.session.sent[0].type,'voice');
 }
});
test('missing readiness and absent explicit request never dispatch TTS',async()=>{
 const f=fixture();f.setAllowed(false);assert.equal((await tool.execute(f.ctx,{text:'你好'})).isError,true);assert.equal(f.calls.tts.length,0);
 f.setAllowed(true);f.ctx.triggerEntries=[{text:'你好'}];await tool.execute(f.ctx,{text:'你好',direct:true});assert.equal(f.calls.tts.length,0);
});
test('known synthesis failure sends the existing sentence as text once without another model',async()=>{
 const f=fixture();f.speech.synthesize=async()=>{throw Object.assign(Error('provider'),{code:'SPEECH_PROVIDER_ERROR',chargeOutcome:'unknown',dispatched:true});};
 const result=await tool.execute(f.ctx,{text:'晚上好。'});assert.ok(!result.isError);assert.equal(f.calls.text.length,1);assert.deepEqual(f.calls.text[0].texts,['晚上好。']);assert.equal(f.calls.voice.length,0);
});
test('cancel or voice authorization change during synthesis suppresses all output',async()=>{
 for(const action of ['cancel','disable']){
  const f=fixture();f.speech.synthesize=async()=>{if(action==='cancel')f.cancel();else f.setAllowed(false);return {audio:Buffer.from('fixture'),transcript:'你好',receipt:{}};};
  assert.equal((await tool.execute(f.ctx,{text:'你好'})).isError,true);assert.equal(f.calls.voice.length,0);assert.equal(f.calls.text.length,0);
 }
});
test('unknown QQ delivery is not retried as audio or duplicate text',async()=>{
 const f=fixture();let attempts=0;f.ctx.sender.sendMedia=async()=>{attempts++;throw Error('fixture QQ timeout');};
 const result=await tool.execute(f.ctx,{text:'你好'});assert.equal(result.isError,true);assert.equal(attempts,1);assert.equal(f.calls.tts.length,1);assert.equal(f.calls.text.length,0);
});
test('closing and reopening voice settings during queued text fallback rejects the stale reply',async()=>{
 const f=fixture();let version='fixture-policy-1';
 f.speech.runtimePolicy=()=>({allowed:true,policyVersion:version,settings:{maxChars:120}});
 f.speech.synthesize=async()=>{throw Object.assign(Error('provider'),{code:'SPEECH_PROVIDER_ERROR'});};
 f.ctx.sender.sendTextBatch=async(key,texts,options)=>{version='fixture-policy-3';options.guard();f.calls.text.push({key,texts});return {sent:[]};};
 assert.equal((await tool.execute(f.ctx,{text:'你好'})).isError,true);assert.equal(f.calls.text.length,0);
});
test('budget admission refusal can reuse the sentence as text without another paid request',async()=>{
 const f=fixture();f.speech.synthesize=async()=>{throw Object.assign(Error('budget'),{code:'SPEECH_ADMISSION_DENIED'});};
 assert.ok(!(await tool.execute(f.ctx,{text:'你好'})).isError);assert.equal(f.calls.voice.length,0);assert.equal(f.calls.text.length,1);
});
test('a resource guard is rechecked after the real media queue delay',async()=>{
 let enabled=true,voice=0,checks=0,signal;const waiting=new Promise(resolve=>{signal=resolve;});
 const queue=new SendQueue({onebot:{async sendSegments(){voice++;return {message_id:1};}},store:{appendSelf(){}}});
 const promise=queue.sendMedia('group:101',[{type:'record',data:{file:'base64://Zml4dHVyZQ=='}}],{guard(){if(++checks===2)signal();if(!enabled)throw Object.assign(Error('disabled'),{code:'SPEECH_AUTHORIZATION_CHANGED'});}});
 const rejected=assert.rejects(promise,/disabled/);await waiting;enabled=false;await rejected;await queue.whenIdle();assert.equal(voice,0);
});
test('automatic probability 0/100/10 uses a fixed program threshold once per complete reply',async()=>{
 for(const [percent,roll,voice] of [[0,0,false],[100,.999,true],[10,.099,true],[10,.1,false]]){
  const f=fixture();let draws=0;f.ctx.triggerEntries=[{text:'晚上好'}];f.speech.runtimePolicy=()=>({allowed:true,policyVersion:'fixture-policy',settings:{maxChars:120,autoVoicePercent:percent}});
  const send=createSpeechReplySender(f.ctx,{random:()=>{draws++;return roll;}});
  await send(['第一段。','第二段。']);await send(['第三段。']);
  assert.equal(draws,1);assert.equal(f.calls.voice.length,voice?1:0);assert.equal(f.calls.tts.length,voice?1:0);
  if(voice){assert.equal(f.calls.tts[0].input.text,'第一段。\n第二段。');assert.equal(f.calls.tts[0].input.purpose,'automatic');assert.equal(f.calls.tts[0].input.direct,false);}
 }
});
test('automatic speech shares the four scoped payer combinations; explicit demand bypasses probability',async()=>{
 for(const key of ['group:101','private:101'])for(const payer of ['platform','byok']){
  const f=fixture(key);f.ctx.modelPayer=payer;let draws=0;f.speech.runtimePolicy=()=>({allowed:true,policyVersion:'fixture-policy',settings:{maxChars:120,autoVoicePercent:0}});
  const send=createSpeechReplySender(f.ctx,{random:()=>{draws++;return .99;}});await send(['明确语音回复。']);assert.equal(draws,0);assert.equal(f.calls.tts[0].input.direct,true);assert.equal(f.calls.voice[0].key,key);
 }
});
test('negative demand, proactive tasks and unsuitable replies retain text without drawing',async()=>{
 for(const mode of ['negative','proactive','url']){
  const f=fixture();f.speech.runtimePolicy=()=>({allowed:true,settings:{maxChars:120,autoVoicePercent:100}});let draws=0;
  if(mode==='negative')f.ctx.triggerEntries=[{text:'不要语音'}];else if(mode==='proactive')f.ctx.proactive=true;else f.ctx.triggerEntries=[{text:'你好'}];
  await createSpeechReplySender(f.ctx,{random:()=>{draws++;return 0;}})([mode==='url'?'https://example.invalid/fixture':'晚上好。']);
  assert.equal(draws,0);assert.equal(f.calls.voice.length,0);assert.equal(f.calls.text.length,1);
 }
});
test('unavailable speech policy retains authorized text and its cancellation guard',async()=>{
 for(const broken of [()=>{throw Error('fixture speech storage unavailable');},()=>({allowed:true})]){
  const f=fixture();f.ctx.triggerEntries=[{text:'晚上好'}];f.speech.runtimePolicy=broken;let draws=0;
  const send=createSpeechReplySender(f.ctx,{random:()=>{draws++;return 0;}});
  await send(['普通文字仍可发送。']);assert.equal(f.calls.text.length,1);assert.equal(f.calls.voice.length,0);assert.equal(draws,0);assert.equal(f.ctx.speechReplyState.decided,true);
  f.cancel();await assert.rejects(send(['已取消的回复不能发送。']),/cancelled/);assert.equal(f.calls.text.length,1);
 }
});
test('plain replies preserve a caller guard rejection for the real queue',async()=>{
 let delivered=0;
 const queue=new SendQueue({onebot:{async sendMessage(){delivered++;return {message_id:1};}},store:{appendSelf(){}}});
 const f=fixture();f.ctx.speech=null;f.ctx.sender=queue;
 await assert.rejects(createSpeechReplySender(f.ctx)(['不能发送。'],{guard:()=>false}),/发送条件已变化/);
 await queue.whenIdle();assert.equal(delivered,0);
});
test('selected automatic speech denied at 80% or failed provider consumes the one decision and falls back',async()=>{
 for(const code of ['SPEECH_ADMISSION_DENIED','SPEECH_PROVIDER_ERROR']){
  const f=fixture();f.ctx.triggerEntries=[{text:'你好'}];f.speech.runtimePolicy=()=>({allowed:true,policyVersion:'fixture-policy',settings:{maxChars:120,autoVoicePercent:10}});let draws=0,attempts=0;
  f.speech.synthesize=async()=>{attempts++;throw Object.assign(Error('fixture'),{code});};
  const send=createSpeechReplySender(f.ctx,{random:()=>{draws++;return .05;}});await send(['晚上好。']);await send(['第二句。']);
  assert.equal(draws,1);assert.equal(attempts,1);assert.equal(f.calls.voice.length,0);assert.equal(f.calls.text.length,2);
 }
});
test('explicit voice success or unknown delivery cannot trigger another automatic conversion',async()=>{
 for(const unknown of [false,true]){
  const f=fixture();f.speech.runtimePolicy=()=>({allowed:true,settings:{maxChars:120,autoVoicePercent:100}});
  if(unknown)f.ctx.sender.sendMedia=async()=>{throw Error('fixture timeout');};
  await tool.execute(f.ctx,{text:'已经尝试过。'});f.ctx.triggerEntries=[{text:'你好'}];let draws=0;
  const pending=createSpeechReplySender(f.ctx,{random:()=>{draws++;return 0;}})(['后续文字。']);
  if(unknown)await assert.rejects(pending,/交付/);else await pending;
  assert.equal(draws,0);assert.equal(f.calls.tts.length,1);
 }
});
test('reply rescue treats known speech transcript as answered without converting arbitrary media',async()=>{
 let grounded;
 const cap=name=>name==='reply.loose-send'?()=>({messages:['晚安。']}):name==='reply.grounded-select'?input=>{grounded=input;return {enabled:true,picked:input.proposed};}:null;
 assert.deepEqual(await rescueUnsentReply({text:'晚安。',sent:[{type:'voice',text:'晚安。'}],cap}),[]);assert.equal(grounded.sent[0].type,'text');
 assert.equal((await rescueUnsentReply({text:'晚安。',sent:[{type:'media',text:'晚安。'}],cap})).length,1);
});

test('quoted replies participate in probability and explicit voice; text fallback keeps the quote',async()=>{
 for(const key of ['group:101','private:101'])for(const requested of [false,true]){
  const f=fixture(key);f.ctx.triggerEntries=[{text:requested?'请用语音回复':'晚上好'}];
  f.speech.runtimePolicy=()=>({allowed:true,settings:{maxChars:120,autoVoicePercent:50}});let draws=0;
  await createSpeechReplySender(f.ctx,{random:()=>{draws++;return .1;}})(['晚安。'],{replyToMessageId:-123});
  assert.equal(draws,requested?0:1);assert.equal(f.calls.tts.length,1);assert.equal(f.calls.voice.length,1);assert.equal(f.calls.text.length,0);
  assert.deepEqual(f.calls.voice[0].segments.map(s=>s.type),['record']);assert.equal(f.ctx.session.speechDecision.status,'sent');assert.equal(f.ctx.session.speechDecision.quotedReply,true);
  assert.doesNotMatch(JSON.stringify(f.ctx.session.speechDecision),/晚安|fixture-audio|base64|secret/i);
 }
 const f=fixture();f.ctx.triggerEntries=[{text:'晚上好'}];f.speech.runtimePolicy=()=>({allowed:true,settings:{maxChars:120,autoVoicePercent:50}});
 await createSpeechReplySender(f.ctx,{random:()=>.9})(['保留引用的文字。'],{replyToMessageId:-123});
 assert.equal(f.calls.tts.length,0);assert.equal(f.calls.text[0].options.replyToMessageId,-123);assert.equal(f.ctx.session.speechDecision.reason,'random_miss');
});

test('selected quoted speech respects caller guards before synthesis and preserves the quote on provider failure',async()=>{
 const f=fixture();f.ctx.triggerEntries=[{text:'晚上好'}];f.speech.runtimePolicy=()=>({allowed:true,policyVersion:'fixture-policy',settings:{maxChars:120,autoVoicePercent:50}});
 await assert.rejects(createSpeechReplySender(f.ctx,{random:()=>0})(['不能发送。'],{replyToMessageId:123,guard:()=>false}),{code:'SPEECH_AUTHORIZATION_CHANGED'});
 assert.equal(f.calls.tts.length,0);assert.equal(f.calls.voice.length,0);assert.equal(f.calls.text.length,0);
 const other=fixture();other.ctx.triggerEntries=[{text:'晚上好'}];other.speech.runtimePolicy=f.speech.runtimePolicy;
 other.speech.synthesize=async()=>{throw Object.assign(Error('fixture'),{code:'SPEECH_COOLDOWN'});};
 await createSpeechReplySender(other.ctx,{random:()=>0})(['冷却时发文字。'],{replyToMessageId:123});
 assert.equal(other.calls.text[0].options.replyToMessageId,123);assert.equal(other.ctx.session.speechDecision.reason,'SPEECH_COOLDOWN');
});
