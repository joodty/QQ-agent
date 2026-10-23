// Tencent's official TextToVoice endpoint. No browser Read-Aloud or fallback API.
import crypto from 'node:crypto';

export const TENCENT_SPEECH = Object.freeze({ endpoint:'https://tts.tencentcloudapi.com/',host:'tts.tencentcloudapi.com',action:'TextToVoice',version:'2019-08-23',voiceType:101001,voiceName:'智瑜',currency:'CNY',rateCnyPer10k:.3 });
// Verified against Tencent's basic TextToVoice catalogue (2026-10-23).
// https://cloud.tencent.com/document/product/1073/92668
// All entries are 精品音色, Chinese, 16 kHz, and share the .3 CNY/10k list price.
export const TENCENT_SPEECH_VOICES=Object.freeze([
  {voiceType:101001,name:'智瑜',gender:'female',style:'情感女声'},
  {voiceType:101055,name:'智付',gender:'female',style:'通用女声'},
  {voiceType:101026,name:'智希',gender:'female',style:'通用女声'},
  {voiceType:101004,name:'智云',gender:'male',style:'通用男声'},
  {voiceType:101030,name:'智柯',gender:'male',style:'通用男声'},
  {voiceType:101013,name:'智辉',gender:'male',style:'新闻男声'}
].map(v=>Object.freeze({...v,language:'zh-CN',category:'premium',sampleRate:16000,rateCnyPer10k:.3})));
export const SPEECH_VOICE_LIMITS=Object.freeze({speedMin:-1,speedMax:2,volumeMin:-5,volumeMax:5,precision:2});
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=(code,dispatched=false)=>Object.assign(new Error(code),{code,dispatched,chargeOutcome:dispatched?'unknown':'not_sent'});
const digest=text=>crypto.createHash('sha256').update(text).digest('hex');
const hmac=(key,text)=>crypto.createHmac('sha256',key).update(text).digest();

export function validateSpeechVoiceOptions({voiceType=101001,speed=0,volume=0}={}) {
  const decimal=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max&&Math.abs(value*100-Math.round(value*100))<1e-8;
  const voice=TENCENT_SPEECH_VOICES.find(v=>v.voiceType===voiceType);
  if(!voice||!decimal(speed,-1,2)||!decimal(volume,-5,5))throw fail('SPEECH_VOICE_INVALID');
  return {voiceType:voice.voiceType,speed,volume};
}

export function validateSpeechCredential(value) {
  if(!plain(value)||Object.keys(value).some(k=>!['format','version','secretId','secretKey','sessionToken'].includes(k))||value.format!=='qq-agent-tencent-speech-credential'||value.version!==1
    ||typeof value.secretId!=='string'||!/^[A-Za-z0-9_-]{8,128}$/.test(value.secretId)
    ||typeof value.secretKey!=='string'||value.secretKey.length<16||value.secretKey.length>256||/[^\x21-\x7e]/.test(value.secretKey)
    ||value.sessionToken!==undefined&&(typeof value.sessionToken!=='string'||value.sessionToken.length<16||value.sessionToken.length>8192||/[^\x21-\x7e]/.test(value.sessionToken)))throw fail('SPEECH_CREDENTIAL_INVALID');
  return {...value};
}
export function quoteSpeechText(text,{maxChars=150}={}) {
  if(typeof text!=='string'||!text.isWellFormed()||!text.trim()||!Number.isSafeInteger(maxChars)||maxChars<1||maxChars>150
    ||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||/[<>]/.test(text))throw fail('SPEECH_TEXT_INVALID');
  // A UTF-16 unit count is exact for Chinese/ASCII and conservatively counts
  // supplementary characters twice; TextToVoice exposes no billed-usage field.
  const characters=text.length;
  // No SSML, normalization or silent truncation: quote exactly what is sent.
  if(characters>maxChars||Buffer.byteLength(text,'utf8')>450)throw fail('SPEECH_TEXT_TOO_LONG');
  return {text,characters,amountCny:Math.ceil(characters*30)/1e6,currency:'CNY',estimated:true,basis:'list-price-free-package-unsynchronized'};
}
export function signTencentSpeech({text,credentials,sessionId,timestamp=Math.floor(Date.now()/1000),voiceType=101001,speed=0,volume=0}) {
  const credential=validateSpeechCredential(credentials);quoteSpeechText(text);
  const voice=validateSpeechVoiceOptions({voiceType,speed,volume});
  if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)||!Number.isSafeInteger(timestamp)||timestamp<0)throw fail('SPEECH_REQUEST_INVALID');
  const body=JSON.stringify({Text:text,SessionId:sessionId,ModelType:1,VoiceType:voice.voiceType,Speed:voice.speed,Volume:voice.volume,PrimaryLanguage:1,SampleRate:16000,Codec:'wav'});
  const date=new Date(timestamp*1000).toISOString().slice(0,10),contentType='application/json; charset=utf-8';
  const canonical='POST\n/\n\ncontent-type:'+contentType+'\nhost:'+TENCENT_SPEECH.host+'\n\ncontent-type;host\n'+digest(body);
  const scope=date+'/tts/tc3_request',toSign='TC3-HMAC-SHA256\n'+timestamp+'\n'+scope+'\n'+digest(canonical);
  const signature=hmac(hmac(hmac('TC3'+credential.secretKey,date),'tts'),'tc3_request');
  const headers={'content-type':contentType,host:TENCENT_SPEECH.host,'X-TC-Action':'TextToVoice','X-TC-Version':TENCENT_SPEECH.version,'X-TC-Timestamp':String(timestamp),Authorization:'TC3-HMAC-SHA256 Credential='+credential.secretId+'/'+scope+', SignedHeaders=content-type;host, Signature='+hmac(signature,toSign).toString('hex')};
  if(credential.sessionToken)headers['X-TC-Token']=credential.sessionToken;
  return {url:TENCENT_SPEECH.endpoint,body,headers};
}

async function boundedJson(response,signal,maxBytes) {
  if(Number(response.headers.get('content-length'))>maxBytes){void response.body?.cancel().catch(()=>{});throw fail('SPEECH_RESPONSE_TOO_LARGE',true);}
  const reader=response.body?.getReader();if(!reader)throw fail('SPEECH_RESPONSE_INVALID',true);
  let abort;const aborted=new Promise((_,reject)=>{abort=()=>reject(fail('SPEECH_CANCELLED',true));});signal.addEventListener('abort',abort,{once:true});
  const chunks=[];let length=0;
  try {if(signal.aborted)abort();for(;;){const row=await Promise.race([reader.read(),aborted]);if(row.done)break;length+=row.value.byteLength;if(length>maxBytes)throw fail('SPEECH_RESPONSE_TOO_LARGE',true);chunks.push(Buffer.from(row.value));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  finally {signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
export function createTencentSpeechProvider({fetch:request=(...args)=>globalThis.fetch(...args),now=Date.now}={}) {
  if(typeof request!=='function'||typeof now!=='function')throw fail('SPEECH_PROVIDER_INVALID');
  return {
    async synthesize({text,credentials,signal,sessionId=crypto.randomUUID(),timeoutMs=10000,beforeRequest,voiceType=101001,speed=0,volume=0}={}) {
      const signed=signTencentSpeech({text,credentials,sessionId,timestamp:Math.floor(now()/1000),voiceType,speed,volume});
      if(typeof beforeRequest!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw fail('SPEECH_REQUEST_INVALID');
      if(signal?.aborted)throw fail('SPEECH_CANCELLED');
      const controller=new AbortController(),cancel=()=>controller.abort(),timeout=Math.max(1000,Math.min(15000,Number(timeoutMs)||10000));
      signal?.addEventListener('abort',cancel,{once:true});let dispatched=false,timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
      try {
        if(controller.signal.aborted)throw fail('SPEECH_CANCELLED');
        const ready=beforeRequest();if(ready?.then)throw fail('SPEECH_REQUEST_INVALID');
        dispatched=true;
        const response=await request(signed.url,{method:'POST',headers:signed.headers,body:signed.body,signal:controller.signal,redirect:'error'});
        if(!response.ok){void response.body?.cancel().catch(()=>{});throw fail('SPEECH_PROVIDER_REJECTED',true);}
        const data=await boundedJson(response,controller.signal,2*1024*1024),result=data?.Response;
        if(!plain(result)||result.Error||result.SessionId!==sessionId||typeof result.RequestId!=='string'||!result.RequestId||typeof result.Audio!=='string'||!result.Audio
          ||result.Audio.length>1400000||result.Audio.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.Audio))throw fail('SPEECH_RESPONSE_INVALID',true);
        const audio=Buffer.from(result.Audio,'base64');
        if(audio.length<44||audio.length>1024*1024||audio.subarray(0,4).toString()!=='RIFF'||audio.subarray(8,12).toString()!=='WAVE')throw fail('SPEECH_AUDIO_INVALID',true);
        return {audio,mime:'audio/wav',requestId:result.RequestId,characters:quoteSpeechText(text).characters};
      } catch(error) {
        if(!dispatched)throw error;
        if(controller.signal.aborted)throw fail(timedOut?'SPEECH_TIMEOUT':'SPEECH_CANCELLED',dispatched);
        if(typeof error?.code==='string'&&error.code.startsWith('SPEECH_'))throw fail(error.code,dispatched);
        throw fail('SPEECH_PROVIDER_FAILED',dispatched);
      } finally {clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    }
  };
}
