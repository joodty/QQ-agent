// Speech settings and explicit platform subsidy, independent from LLM Key ownership.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from './config.js';
import { productionPaidCallGuard,runWithPaidConversation,capturePaidFunding,capturePaidAuthority,assertPaidAuthority } from './paid-call-guard.js';
import { createTencentSpeechProvider,validateSpeechCredential,quoteSpeechText,validateSpeechVoiceOptions,safeTencentSpeechErrorCode,TENCENT_SPEECH,TENCENT_SPEECH_VOICES,SPEECH_VOICE_LIMITS } from './speech-provider.js';

const APP_ID=0x51535048,SCHEMA=3;
const key=x=>typeof x==='string'&&/^(group|private):[1-9]\d*$/.test(x)&&Number.isSafeInteger(Number(x.split(':')[1]));
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const money=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0&&x<=1000000&&Math.abs(x*1e6-Math.round(x*1e6))<.00001;
const exact=(x,fields)=>object(x)&&Object.keys(x).every(k=>fields.includes(k));
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=(code,statusCode=403,outcome='not_sent')=>Object.assign(new Error(code),{code,statusCode,dispatched:outcome!=='not_sent',chargeOutcome:outcome});
const parse=text=>{try{return JSON.parse(text);}catch{throw fail('SPEECH_STORAGE_INVALID',503);}};
const DEFAULT_PLATFORM={version:1,enabled:false,maxChars:120,cooldownMs:60000,dailyLimitCny:1,voiceType:101001,speed:0,volume:0,autoVoicePercent:0};
const percent=x=>Number.isSafeInteger(x)&&x>=0&&x<=100;
const voiceValid=v=>{try{validateSpeechVoiceOptions(v);return true;}catch{return false;}};
const validPlatform=p=>exact(p,['version','enabled','maxChars','cooldownMs','dailyLimitCny','voiceType','speed','volume','autoVoicePercent'])&&Number.isSafeInteger(p.version)&&p.version>=1&&typeof p.enabled==='boolean'&&Number.isSafeInteger(p.maxChars)&&p.maxChars>=1&&p.maxChars<=150&&Number.isSafeInteger(p.cooldownMs)&&p.cooldownMs>=1000&&p.cooldownMs<=3600000&&money(p.dailyLimitCny)&&Object.hasOwn(p,'voiceType')&&Object.hasOwn(p,'speed')&&Object.hasOwn(p,'volume')&&percent(p.autoVoicePercent)&&voiceValid(p);

export function readSpeechCredential(file) {
  try {
    if(typeof file!=='string'||!path.isAbsolute(file))return null;
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw fail('SPEECH_CREDENTIAL_INVALID');
    return validateSpeechCredential(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));
  } catch(error){if(error?.code==='ENOENT')return null;throw fail('SPEECH_CREDENTIAL_INVALID',503);}
}

export function createSpeechService({file,auth,store,orchestrator,config=getConfig,credentials,guard=productionPaidCallGuard,provider=createTencentSpeechProvider()}={}) {
  if(typeof file!=='string'||!path.isAbsolute(file)||!auth||typeof config!=='function'||typeof guard!=='function'||typeof provider?.synthesize!=='function')throw fail('SPEECH_DEPENDENCY_INVALID',503);
  fs.mkdirSync(path.dirname(file),{recursive:true});const existed=fs.existsSync(file),db=new DatabaseSync(file);
  const transact=work=>{db.exec('BEGIN IMMEDIATE');try{const value=work();if(value?.then)throw fail('SPEECH_STORAGE_INVALID',503);db.exec('COMMIT');return value;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}};
  try {
    db.exec('PRAGMA busy_timeout=10000');
    if(!existed)transact(()=>{db.exec(`CREATE TABLE speech_meta(name TEXT PRIMARY KEY,value_json TEXT NOT NULL) STRICT;CREATE TABLE speech_scopes(chat_key TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL,max_chars INTEGER,cooldown_ms INTEGER,voice_type INTEGER,speed REAL,volume REAL,auto_voice_percent INTEGER) STRICT;CREATE TABLE speech_subsidies(chat_key TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL,modes_json TEXT NOT NULL,daily_limit_micros INTEGER NOT NULL) STRICT;PRAGMA application_id=${APP_ID};PRAGMA user_version=${SCHEMA};`);db.prepare('INSERT INTO speech_meta VALUES(?,?)').run('platform',JSON.stringify(DEFAULT_PLATFORM));});
    if(db.prepare('PRAGMA application_id').get().application_id!==APP_ID||db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw fail('SPEECH_STORAGE_INVALID',503);
    if(db.prepare('PRAGMA user_version').get().user_version===1)transact(()=>{
      const old=parse(db.prepare("SELECT value_json FROM speech_meta WHERE name='platform'").get()?.value_json);
      if(!exact(old,['version','enabled','maxChars','cooldownMs','dailyLimitCny'])||Object.keys(old).length!==5||!validPlatform({...old,voiceType:101001,speed:0,volume:0,autoVoicePercent:0}))throw fail('SPEECH_STORAGE_INVALID',503);
      db.exec('ALTER TABLE speech_scopes ADD COLUMN voice_type INTEGER;ALTER TABLE speech_scopes ADD COLUMN speed REAL;ALTER TABLE speech_scopes ADD COLUMN volume REAL;');
      db.prepare("UPDATE speech_meta SET value_json=? WHERE name='platform'").run(JSON.stringify({...old,voiceType:101001,speed:0,volume:0}));db.exec('PRAGMA user_version=2');
    });
    if(db.prepare('PRAGMA user_version').get().user_version===2)transact(()=>{
      const old=parse(db.prepare("SELECT value_json FROM speech_meta WHERE name='platform'").get()?.value_json);
      if(!exact(old,['version','enabled','maxChars','cooldownMs','dailyLimitCny','voiceType','speed','volume'])||Object.keys(old).length!==8||!validPlatform({...old,autoVoicePercent:0}))throw fail('SPEECH_STORAGE_INVALID',503);
      db.exec('ALTER TABLE speech_scopes ADD COLUMN auto_voice_percent INTEGER;');db.prepare("UPDATE speech_meta SET value_json=? WHERE name='platform'").run(JSON.stringify({...old,autoVoicePercent:0}));db.exec(`PRAGMA user_version=${SCHEMA}`);
    });
    if(db.prepare('PRAGMA user_version').get().user_version!==SCHEMA)throw fail('SPEECH_STORAGE_INVALID',503);
  } catch(error){db.close();throw fail('SPEECH_STORAGE_INVALID',503);}
  const receipts=new WeakMap();let activeSyntheses=0,closed=false;
  function platform(){const p=parse(db.prepare("SELECT value_json FROM speech_meta WHERE name='platform'").get()?.value_json);if(!validPlatform(p))throw fail('SPEECH_STORAGE_INVALID',503);return p;}
  function fresh(principal){try{return auth.verifyPrincipal(principal);}catch{throw fail('SPEECH_UNAUTHENTICATED',401);}}
  function scope(principal,chatKey,write=false){const p=fresh(principal);if(!key(chatKey)||!auth.canAccess(p,chatKey,{botId:'primary',write}))throw fail('SPEECH_ACCESS_DENIED');return p;}
  function admin(principal){const p=fresh(principal);if(p.role!=='admin')throw fail('SPEECH_ACCESS_DENIED');return p;}
  function credential(){const value=credentials?credentials():readSpeechCredential(config()?.speech?.credentialFile);return value===null||value===undefined?null:validateSpeechCredential(value);}
  function rowFor(chatKey){const row=db.prepare('SELECT * FROM speech_scopes WHERE chat_key=?').get(chatKey);if(row&&(!Number.isSafeInteger(row.version)||row.version<1||![0,1].includes(row.enabled)||row.max_chars!==null&&(!Number.isSafeInteger(row.max_chars)||row.max_chars<1||row.max_chars>150)||row.cooldown_ms!==null&&(!Number.isSafeInteger(row.cooldown_ms)||row.cooldown_ms<1000||row.cooldown_ms>3600000)||row.auto_voice_percent!==null&&!percent(row.auto_voice_percent)||!voiceValid({voiceType:row.voice_type??101001,speed:row.speed??0,volume:row.volume??0})))throw fail('SPEECH_STORAGE_INVALID',503);return row;}
  function subsidy(chatKey){const row=db.prepare('SELECT * FROM speech_subsidies WHERE chat_key=?').get(chatKey);if(!row)return {chatKey,version:0,enabled:false,allowedFundingModes:[],dailyLimitCny:0};const modes=parse(row.modes_json);if(!Number.isSafeInteger(row.version)||row.version<1||![0,1].includes(row.enabled)||!Array.isArray(modes)||new Set(modes).size!==modes.length||modes.some(m=>!['platform','trial','byok'].includes(m))||!Number.isSafeInteger(row.daily_limit_micros)||!money(row.daily_limit_micros/1e6))throw fail('SPEECH_STORAGE_INVALID',503);return {chatKey,version:row.version,enabled:Boolean(row.enabled),allowedFundingModes:modes,dailyLimitCny:row.daily_limit_micros/1e6};}
  function projection(chatKey){
    if(!key(chatKey))throw fail('SPEECH_SCOPE_INVALID');const p=platform(),row=rowFor(chatKey),grant=subsidy(chatKey);let secret=null,reason='';
    try{secret=credential();}catch{reason='SPEECH_CREDENTIAL_INVALID';}
    let funding;try{funding=capturePaidFunding(chatKey);}catch{reason=reason||'SPEECH_FUNDING_UNAVAILABLE';}
    if(!secret)reason=reason||'SPEECH_NO_CREDENTIAL';
    if(!p.enabled||config()?.speech?.enabled===false)reason=reason||'SPEECH_PLATFORM_DISABLED';
    if(!row?.enabled)reason=reason||'SPEECH_CHAT_DISABLED';
    if(!grant.enabled||!grant.allowedFundingModes.includes(funding?.mode)||grant.dailyLimitCny<=0||p.dailyLimitCny<=0)reason=reason||'SPEECH_SUBSIDY_REQUIRED';
    const voice=validateSpeechVoiceOptions({voiceType:row?.voice_type??p.voiceType,speed:row?.speed??p.speed,volume:row?.volume??p.volume});
    const settings={version:row?.version||0,enabled:Boolean(row?.enabled),maxChars:Math.min(row?.max_chars??p.maxChars,p.maxChars),cooldownMs:Math.max(row?.cooldown_ms??p.cooldownMs,p.cooldownMs),...voice,autoVoicePercent:row?.auto_voice_percent??p.autoVoicePercent,overrides:{voiceType:row?.voice_type??null,speed:row?.speed??null,volume:row?.volume??null,autoVoicePercent:row?.auto_voice_percent??null}};
    const version=hash([p,settings,grant,secret?hash(secret):null,funding]),voiceName=TENCENT_SPEECH_VOICES.find(v=>v.voiceType===voice.voiceType).name;
    return {public:{chatKey,allowed:!reason,reason:reason||null,configured:Boolean(secret),enabled:p.enabled&&settings.enabled,settings,subsidy:grant,provider:'tencent',...voice,voiceName,voices:TENCENT_SPEECH_VOICES,voiceLimits:SPEECH_VOICE_LIMITS,policyVersion:version,rateCnyPer10k:.3,currency:'CNY',estimated:true,estimationBoundary:'按标价估算；免费资源包实际抵扣未同步。'},secret,funding,version};
  }
  function changed(chatKey){orchestrator?.archiveChanged?.(chatKey);}
  const service={
    runtimePolicy(chatKey){return projection(chatKey).public;},
    settings(principal,chatKey){scope(principal,chatKey);return projection(chatKey).public;},
    overview(principal){const p=fresh(principal);return {platform:service.platformOverview(p,{publicOnly:true}),conversations:auth.listScopes(p,{botId:'primary'}).map(k=>projection(k).public)};},
    platformOverview(principal,{publicOnly=false}={}){const p=fresh(principal),settings=platform();let configured=false;try{configured=Boolean(credential());}catch{}return {...settings,configured,provider:'tencent',voiceName:TENCENT_SPEECH_VOICES.find(v=>v.voiceType===settings.voiceType).name,voices:TENCENT_SPEECH_VOICES,voiceLimits:SPEECH_VOICE_LIMITS,rateCnyPer10k:.3,currency:'CNY',estimated:true,estimationBoundary:'按标价估算；免费资源包实际抵扣未同步。',...(p.role==='admin'&&!publicOnly?{subsidies:db.prepare('SELECT chat_key FROM speech_subsidies ORDER BY chat_key').all().map(r=>subsidy(r.chat_key))}:{})};},
    updateSettings(principal,fields){
      if(!exact(fields,['chatKey','expectedVersion','enabled','maxChars','cooldownMs','voiceType','speed','volume','autoVoicePercent']))throw fail('SPEECH_SETTINGS_INVALID',400);
      scope(principal,fields.chatKey,true);
      return transact(()=>{
        const p=platform(),old=rowFor(fields.chatKey),version=old?.version||0;
        if(fields.expectedVersion!==version)throw fail('SPEECH_VERSION_CONFLICT',409);
        if(typeof fields.enabled!=='boolean'||fields.maxChars!==undefined&&(!Number.isSafeInteger(fields.maxChars)||fields.maxChars<1||fields.maxChars>p.maxChars)||fields.cooldownMs!==undefined&&(!Number.isSafeInteger(fields.cooldownMs)||fields.cooldownMs<p.cooldownMs||fields.cooldownMs>3600000))throw fail('SPEECH_SETTINGS_INVALID',400);
        const overrides={voiceType:old?.voice_type??null,speed:old?.speed??null,volume:old?.volume??null};
        for(const field of Object.keys(overrides))if(Object.hasOwn(fields,field)){if(fields[field]===undefined)throw fail('SPEECH_VOICE_INVALID',400);overrides[field]=fields[field];}
        if(!voiceValid({voiceType:overrides.voiceType??p.voiceType,speed:overrides.speed??p.speed,volume:overrides.volume??p.volume}))throw fail('SPEECH_VOICE_INVALID',400);
        const autoVoicePercent=Object.hasOwn(fields,'autoVoicePercent')?fields.autoVoicePercent:old?.auto_voice_percent??null;
        if(autoVoicePercent!==null&&!percent(autoVoicePercent))throw fail('SPEECH_SETTINGS_INVALID',400);
        const grant=subsidy(fields.chatKey);if(fields.enabled&&!grant.enabled)throw fail('SPEECH_SUBSIDY_REQUIRED');
        if(fields.enabled&&!credential())throw fail('SPEECH_NO_CREDENTIAL');
        db.prepare('INSERT INTO speech_scopes VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_key) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,max_chars=excluded.max_chars,cooldown_ms=excluded.cooldown_ms,voice_type=excluded.voice_type,speed=excluded.speed,volume=excluded.volume,auto_voice_percent=excluded.auto_voice_percent').run(fields.chatKey,version+1,fields.enabled?1:0,fields.maxChars??old?.max_chars??null,fields.cooldownMs??old?.cooldown_ms??null,overrides.voiceType,overrides.speed,overrides.volume,autoVoicePercent);
        changed(fields.chatKey);return projection(fields.chatKey).public;
      });
    },
    updatePlatform(principal,fields){admin(principal);if(!exact(fields,['expectedVersion','enabled','maxChars','cooldownMs','dailyLimitCny','voiceType','speed','volume','autoVoicePercent']))throw fail('SPEECH_SETTINGS_INVALID',400);return transact(()=>{const old=platform();if(fields.expectedVersion!==old.version)throw fail('SPEECH_VERSION_CONFLICT',409);const next={...old,...Object.fromEntries(Object.entries(fields).filter(([k])=>k!=='expectedVersion')),version:old.version+1};if(!validPlatform(next))throw fail('SPEECH_SETTINGS_INVALID',400);if(next.enabled&&!credential())throw fail('SPEECH_NO_CREDENTIAL');db.prepare("UPDATE speech_meta SET value_json=? WHERE name='platform'").run(JSON.stringify(next));for(const row of db.prepare('SELECT chat_key FROM speech_scopes').all())changed(row.chat_key);return service.platformOverview(principal);});},
    updateSubsidy(principal,fields){admin(principal);if(!exact(fields,['chatKey','expectedVersion','enabled','allowedFundingModes','dailyLimitCny'])||!key(fields.chatKey)||typeof fields.enabled!=='boolean'||!Array.isArray(fields.allowedFundingModes)||!fields.allowedFundingModes.length||new Set(fields.allowedFundingModes).size!==fields.allowedFundingModes.length||fields.allowedFundingModes.some(m=>!['platform','trial','byok'].includes(m))||!money(fields.dailyLimitCny)||fields.enabled&&fields.dailyLimitCny<=0)throw fail('SPEECH_SUBSIDY_INVALID',400);scope(principal,fields.chatKey,true);return transact(()=>{const old=subsidy(fields.chatKey);if(fields.expectedVersion!==old.version)throw fail('SPEECH_VERSION_CONFLICT',409);db.prepare('INSERT INTO speech_subsidies VALUES(?,?,?,?,?) ON CONFLICT(chat_key) DO UPDATE SET version=excluded.version,enabled=excluded.enabled,modes_json=excluded.modes_json,daily_limit_micros=excluded.daily_limit_micros').run(fields.chatKey,old.version+1,fields.enabled?1:0,JSON.stringify(fields.allowedFundingModes),Math.round(fields.dailyLimitCny*1e6));changed(fields.chatKey);return subsidy(fields.chatKey);});},
    assertCurrent(receipt){const captured=receipts.get(receipt);if(!captured)throw fail('SPEECH_RECEIPT_INVALID');const current=projection(captured.key);if(!current.public.allowed||current.version!==captured.version)throw fail('SPEECH_AUTHORIZATION_CHANGED');assertPaidAuthority(captured.key,captured.authority);store?.assertArchiveCurrent?.(captured.key,captured.archive);if(captured.signal?.aborted)throw fail('SPEECH_CANCELLED');return true;},
    async synthesize(chatKey,{text,operationId=crypto.randomUUID(),signal,direct=false,purpose='requested',automaticSelected=false}={}) {
      let token=null,dispatched=false,settled=false,ledger,slot=false;
      try {
        if(!['requested','automatic'].includes(purpose)||purpose==='requested'&&direct!==true||purpose==='automatic'&&automaticSelected!==true)throw fail('SPEECH_EXPLICIT_REQUEST_REQUIRED');
        return await runWithPaidConversation(chatKey,async()=>{
          const initial=projection(chatKey);if(!initial.public.allowed)throw fail(initial.public.reason);
          if(purpose==='automatic'&&initial.public.settings.autoVoicePercent<=0)throw fail('SPEECH_AUTOMATIC_DISABLED');
          if(signal?.aborted)throw fail('SPEECH_CANCELLED');
          const quoted=quoteSpeechText(text,{maxChars:initial.public.settings.maxChars});
          const receipt=Object.freeze({id:crypto.randomUUID(),chatKey});
          receipts.set(receipt,{key:chatKey,version:initial.version,authority:capturePaidAuthority(chatKey),archive:store?.captureArchive?.(chatKey)||null,signal});
          const assertAuthorized=()=>{service.assertCurrent(receipt);const current=projection(chatKey);return {id:'tencent-speech-platform',version:current.version,scopeDailyLimitCny:current.public.subsidy.dailyLimitCny,platformDailyLimitCny:platform().dailyLimitCny,cooldownMs:current.public.settings.cooldownMs};};
          // One application process is enforced by the app's instance lock.
          // Keep audio/body allocations bounded; excess requests never queue here.
          if(activeSyntheses>=2)throw fail('SPEECH_BUSY',429);
          activeSyntheses++;slot=true;
          ledger=guard();if(!ledger)throw fail('SPEECH_BUDGET_UNAVAILABLE',503);
          token=ledger.prepareService({service:'speech',operationId,amountCny:quoted.amountCny,assertAuthorized,purpose});
          const {voiceType,speed,volume}=initial.public.settings;
          const audio=await provider.synthesize({text:quoted.text,credentials:initial.secret,voiceType,speed,volume,signal,timeoutMs:config()?.speech?.timeoutMs,beforeRequest(){service.assertCurrent(receipt);ledger.dispatchService(token);dispatched=true;}});
          if(!dispatched)throw fail('SPEECH_PROVIDER_INVALID',503);
          ledger.settleService(token);settled=true;service.assertCurrent(receipt);
          return {...audio,transcript:quoted.text,receipt,estimatedCostCny:quoted.amountCny,estimated:true,estimationBoundary:'按标价估算；免费资源包实际抵扣未同步。'};
        });
      } catch(error){
        if(token&&!settled){try{if(dispatched)ledger.unknownService(token,error?.code==='SPEECH_CANCELLED'?'cancelled':'provider_error');else ledger.releaseService(token);}catch{throw fail('SPEECH_LEDGER_UNAVAILABLE',503,dispatched?'unknown':'not_sent');}}
        const code=typeof error?.code==='string'&&error.code.startsWith('SPEECH_')?error.code:'SPEECH_ADMISSION_DENIED';
        const rejected=fail(code,error?.statusCode||403,settled?'settled':dispatched?'unknown':'not_sent');
        const providerErrorCode=safeTencentSpeechErrorCode(error?.providerErrorCode);if(providerErrorCode)rejected.providerErrorCode=providerErrorCode;
        throw rejected;
      } finally {if(slot)activeSyntheses--;}
    },
    close(){if(!closed){db.close();closed=true;}}
  };
  try{platform();}catch(error){db.close();throw error;}return service;
}
