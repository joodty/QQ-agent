import test from 'node:test';
import assert from 'node:assert/strict';
import {TENCENT_SPEECH_VOICES,TENCENT_SPEECH_VOICE_CATALOGUE,TENCENT_SPEECH_SAMPLE_ORIGINS} from '../src/speech-voices.js';
import {buildSpeechVoiceCatalogue,parseBasicSpeechTable,SAMPLE_ORIGIN} from '../scripts/update-speech-voices.mjs';

function fixture(){
  const ids=[101001,101055,101026,101004,101030,101013,501000,402000];
  const names=new Map(TENCENT_SPEECH_VOICES.map(v=>[v.voiceType,v.name]));
  const row=id=>[id,names.get(id),'通用女声',id===501000?'大模型音色':id===402000?'超自然大模型音色':'精品音色','中文','8k/16k','中性'];
  const table=ids.map(row).map(r=>'<tr>'+r.map(v=>'<td>'+v+'</td>').join('')+'</tr>').join('');
  const html='<h2>基础语音合成音色列表</h2><table><tr><th>header</th></tr>'+table+'</table>';
  const response={code:0,data:{Response:{CategoryVoiceList:[{CategoryName:'聊天',VoiceList:ids.map(id=>({VoiceType:id,VoiceName:names.get(id),VoiceDesc:'亲切',VoiceQuality:id===501000?'3':id===402000?'4':'2',VoiceGender:'girl',VoiceAudio:SAMPLE_ORIGIN+'/'+id+'.wav'}))}]}}};
  return {html,response};
}

test('offline catalogue covers all three public categories and preserves prior IDs',()=>{
  assert.equal(TENCENT_SPEECH_VOICES.length,60);
  assert.equal(new Set(TENCENT_SPEECH_VOICES.map(v=>v.voiceType)).size,60);
  assert.equal(TENCENT_SPEECH_VOICE_CATALOGUE.count,60);
  assert.deepEqual(Object.fromEntries(['premium','large-model','supernatural'].map(c=>[c,TENCENT_SPEECH_VOICES.filter(v=>v.category===c).length])),{premium:14,'large-model':17,supernatural:29});
  for(const id of [101001,101055,101026,101004,101030,101013])assert.ok(TENCENT_SPEECH_VOICES.find(v=>v.voiceType===id));
  assert.ok(Object.isFrozen(TENCENT_SPEECH_VOICES));
  for(const v of TENCENT_SPEECH_VOICES){
    assert.ok(Object.isFrozen(v));assert.equal(v.sampleRate,16000);assert.equal(v.rateCnyPer10k,{premium:.3,'large-model':1.2,supernatural:6.5}[v.category]);
    assert.ok(['female','male','unknown'].includes(v.gender));assert.ok(v.style);assert.ok(v.scenario);assert.ok(['zh-CN','en-US','zh-CN,en-US'].includes(v.language));
  }
});

test('restricted official samples are not advertised as freely playable off-site',()=>{
  assert.ok(Object.isFrozen(TENCENT_SPEECH_SAMPLE_ORIGINS));
  assert.deepEqual(TENCENT_SPEECH_SAMPLE_ORIGINS,[]);
  for(const voice of TENCENT_SPEECH_VOICES){
    assert.equal(voice.sampleUrl,null);assert.equal(voice.sampleAvailability,'official-site-only');
    assert.equal(voice.officialSampleUrl,undefined);
  }
});

test('maintenance builder verifies basic API support and normalizes vendor child gender',()=>{
  const {response,html}=fixture();const rows=buildSpeechVoiceCatalogue(response,html);
  assert.equal(rows.length,8);assert.equal(rows.find(v=>v.voiceType===501000).rateCnyPer10k,1.2);assert.equal(rows.find(v=>v.voiceType===402000).rateCnyPer10k,6.5);
  assert.ok(rows.every(v=>v.gender==='female'&&v.scenario==='聊天'&&v.sampleUrl===null));
  // A real-time-only table must not be accepted as TextToVoice support.
  assert.throws(()=>parseBasicSpeechTable(html.replace('基础语音合成','实时语音合成')));
});

test('maintenance builder refuses incomplete, duplicate, drifting or unsafe sources',()=>{
  const mutate=fn=>{const {response,html}=fixture();fn(response);assert.throws(()=>buildSpeechVoiceCatalogue(response,html));};
  const list=r=>r.data.Response.CategoryVoiceList[0].VoiceList;
  mutate(r=>list(r).pop());
  mutate(r=>list(r).push({...list(r)[0]}));
  mutate(r=>list(r)[0].VoiceQuality='4');
  mutate(r=>list(r)[0].VoiceType=999999);
  mutate(r=>list(r)[0].VoiceName='wrong name');
  mutate(r=>list(r)[0].VoiceGender='anything');
  mutate(r=>{r.code=1;});
  for(const url of ['https://example.invalid/voice.wav','http://tts-tone-audio-1300466766.cos.ap-shanghai.myqcloud.com/voice.wav',SAMPLE_ORIGIN+'/voice.wav?signature=private',SAMPLE_ORIGIN+'/voice.wav#fragment','https://user:pass@tts-tone-audio-1300466766.cos.ap-shanghai.myqcloud.com/voice.wav',SAMPLE_ORIGIN+'/voice.html'])mutate(r=>list(r)[0].VoiceAudio=url);
  const {response,html}=fixture();
  assert.throws(()=>buildSpeechVoiceCatalogue(response,html.replace('8k/16k','8k')));
  assert.throws(()=>buildSpeechVoiceCatalogue(response,html.replace('中文','未知语言')));
});
