import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quotedVoiceInChat, selectVoiceInput, transcribeQqVoice } from '../src/qq-voice-input.js';
import { segmentsToText } from '../src/onebot.js';

const record = { type: 'record', data: { file: 'fixture' } };
const at = { type: 'at', data: { qq: '200' } };
const reply = { type: 'reply', data: { id: '-100' } };
const listen = { type: 'text', data: { text: '听一下他说了什么' } };

test('private voice and explicitly addressed group voice are eligible', () => {
  const select = (kind, segments) => selectVoiceInput({ kind, segments, selfId: '200' });
  assert.equal(select('private', [record]), 'direct');
  assert.equal(select('group', [at, record]), 'direct');
  assert.equal(select('group', [record]), null);
  assert.equal(select('group', [at, reply]), null);
  assert.equal(select('group', [reply, listen]), null);
  assert.equal(select('group', [at, reply, listen]), 'quote');
  assert.equal(select('private', [reply, listen]), 'quote');
});

test('the quoted voice must come from the same conversation', () => {
  const message = { message: [record], group_id: 90, sender: { user_id: 40 } };
  assert.equal(quotedVoiceInChat(message, 'group', '90', '200'), true);
  assert.equal(quotedVoiceInChat(message, 'group', '91', '200'), false);
  assert.equal(quotedVoiceInChat(message, 'private', '40', '200'), false);
  assert.equal(quotedVoiceInChat({ ...message, message_type: 'private' }, 'private', '40', '200'), true);
  assert.equal(quotedVoiceInChat({ ...message, message: [listen] }, 'group', '90', '200'), false);
});

test('uses the native OneBot operation and renders text or an honest fallback', async () => {
  const onebot = { async call(action, params, timeout) {
    assert.equal(action, 'fetch_ptt_text');
    assert.deepEqual(params, { message_id: -100 });
    assert.equal(timeout, 8000);
    return { text: '明天\n晚上七点' };
  } };
  const voiceText = await transcribeQqVoice(onebot, '-100');
  assert.equal(voiceText, '[语音转文字] 明天 晚上七点');
  assert.equal(await segmentsToText([record, record], { voiceText }), voiceText + '[语音]');
  const unavailable = await transcribeQqVoice({ async call() { throw Error('failure'); } }, '-100');
  assert.equal(await segmentsToText([record], { voiceText: unavailable }), '[语音未识别]');
});
