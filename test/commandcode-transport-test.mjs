import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommandCodeRequest, normalizeCommandCodeResponse, COMMANDCODE_PROTOCOL_VERSION, COMMANDCODE_REQUEST_LIMIT, COMMANDCODE_RESPONSE_LIMIT } from '../src/commandcode-transport.js';

const model = 'deepseek/deepseek-v4.1-flash';
const api = () => ({ transport: 'commandcode-generate', baseUrl: 'https://api.commandcode.ai/alpha', apiKey: 'fixture-commandcode-authentication', model });
const body = () => ({ model, messages: [{ role: 'system', content: 'FIXTURE_SYSTEM' }, { role: 'user', content: 'FIXTURE_USER' }], stream: false, max_tokens: 128 });
const build = value => buildCommandCodeRequest({ api: api(), body: value || body() });
const ndjson = events => events.map(event => JSON.stringify(event)).join('\n') + '\n';
const textEvents = (extra = {}) => [{ type: 'start' }, { type: 'start-step' }, { type: 'text-start', id: 'txt-0' }, { type: 'text-delta', id: 'txt-0', text: 'Fixture response' }, { type: 'text-end', id: 'txt-0' }, { type: 'finish-step', finishReason: 'stop' }, { type: 'finish', finishReason: 'stop', ...extra }];
const normalize = (events, options = {}) => JSON.parse(normalizeCommandCodeResponse(ndjson(events), { model, ...options }));
const fails = (fn, code) => assert.throws(fn, error => error.code === 'COMMANDCODE_' + code);
const tool = name => ({ type: 'function', function: { name, description: 'Fixture tool ' + name, parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } } });

test('exact endpoint, real bearer and truthful client identity preserve the quoted model/output cap', () => {
  const input = body(), request = build(input);
  assert.equal(request.url, 'https://api.commandcode.ai/alpha/generate'); assert.equal(request.headers.authorization, 'Bearer fixture-commandcode-authentication');
  assert.equal(request.headers['user-agent'], 'qq-agent/0.4.0'); assert.equal(request.headers['x-command-code-version'], COMMANDCODE_PROTOCOL_VERSION);
  assert.equal(request.headers['x-cli-surface'], undefined); assert.equal(request.headers['x-cli-environment'], undefined);
  assert.equal(request.body.params.max_tokens, 128); assert.equal(request.body.params.model, model); assert.equal(request.body.params.stream, true);
  assert.equal(request.body.params.system, 'FIXTURE_SYSTEM'); assert.deepEqual(request.body.params.messages, [{ role: 'user', content: [{ type: 'text', text: 'FIXTURE_USER' }] }]);
  assert.deepEqual(input, body()); assert.equal(JSON.stringify(request.body).includes(api().apiKey), false);
});

test('transport never guesses credential, endpoint, model or a missing/expanded output limit', () => {
  for (const patch of [{ transport: 'openai' }, { baseUrl: 'https://example.invalid/alpha' }, { baseUrl: 'https://api.commandcode.ai/alpha/' }, { baseUrl: 'http://api.commandcode.ai/alpha' }]) fails(() => buildCommandCodeRequest({ api: { ...api(), ...patch }, body: body() }), 'INVALID_ENDPOINT');
  for (const apiKey of ['', undefined, 'fixture\r\nheader']) fails(() => buildCommandCodeRequest({ api: { ...api(), apiKey }, body: body() }), 'MISSING_CREDENTIAL');
  fails(() => build({ ...body(), model: 'unapproved-model' }), 'MODEL_MISMATCH');
  for (const max_tokens of [undefined, 0, -1, 1.5, 64001, '128']) fails(() => build({ ...body(), max_tokens }), 'OUTPUT_CAP');
  fails(() => build({ ...body(), max_completion_tokens: 900 }), 'UNSUPPORTED_PARAMETER');
  assert.equal(build({ ...body(), max_tokens: 1 }).body.params.max_tokens, 1);
});

test('system instructions and full assistant/tool role identities survive multiple multi-tool rounds', () => {
  const input = { ...body(), tools: [tool('first'), tool('second')], tool_choice: 'auto', messages: [
    { role: 'system', content: 'First system' }, { role: 'user', content: 'One' },
    { role: 'assistant', content: null, reasoning_content: 'Prior reasoning', tool_calls: [
      { id: 'call-a', type: 'function', function: { name: 'first', arguments: '{"text":"A"}' } },
      { id: 'call-b', type: 'function', function: { name: 'second', arguments: '{"text":"B"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call-b', content: 'Result B' }, { role: 'tool', tool_call_id: 'call-a', content: 'Result A' },
    { role: 'assistant', content: 'Next', tool_calls: [{ id: 'call-c', type: 'function', function: { name: 'first', arguments: '{"text":"C"}' } }] },
    { role: 'tool', tool_call_id: 'call-c', content: [{ type: 'text', text: 'Result ' }, { type: 'text', text: 'C' }] },
    { role: 'system', content: 'Later guard instruction' }, { role: 'user', content: 'Continue' }
  ] };
  const { params } = build(input).body;
  assert.equal(params.system, 'First system\n\nLater guard instruction');
  assert.deepEqual(params.tools[0], { name: 'first', description: 'Fixture tool first', input_schema: input.tools[0].function.parameters });
  assert.deepEqual(params.messages[1].content.map(part => part.type), ['reasoning', 'tool-call', 'tool-call']);
  assert.deepEqual(params.messages.slice(2, 4).map(message => [message.role, message.content[0].toolCallId, message.content[0].toolName]), [['tool', 'call-b', 'second'], ['tool', 'call-a', 'first']]);
  assert.equal(params.messages[5].content[0].output.value, 'Result C'); assert.equal(params.messages.at(-1).role, 'user');
});

test('missing/unknown tool results, malformed arguments and unsupported roles fail rather than fabricate history', () => {
  const call = { role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'first', arguments: '{}' } }] };
  fails(() => build({ ...body(), messages: [call] }), 'INVALID_TOOL_HISTORY');
  fails(() => build({ ...body(), messages: [{ role: 'tool', tool_call_id: 'unknown', content: 'orphan' }] }), 'INVALID_TOOL_HISTORY');
  fails(() => build({ ...body(), messages: [call, { role: 'user', content: 'No result' }] }), 'INVALID_TOOL_HISTORY');
  for (const args of ['{', '[]', 'null']) fails(() => build({ ...body(), messages: [{ ...call, tool_calls: [{ ...call.tool_calls[0], function: { name: 'first', arguments: args } }] }] }), 'INVALID_TOOL');
  fails(() => build({ ...body(), messages: [{ role: 'developer', content: 'Unknown priority' }] }), 'UNSUPPORTED_ROLE');
});

test('real orchestrator assistantEntry receipts and named tool results survive the second request without leaking metadata', () => {
  const responseRaw = { object: 'chat.completion', model, choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'runtime-call', type: 'function', function: { name: 'first', arguments: '{"text":"runtime"}' } }] } }], usage: { prompt_tokens: 8, completion_tokens: 2 }, fixtureLocalReceipt: 'DO_NOT_SEND_RECEIPT' };
  const msg = responseRaw.choices[0].message;
  const assistantEntry = { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls, raw: responseRaw, inlineParsed: true, rescued: false };
  const input = { ...body(), tools: [tool('first')], tool_choice: 'auto', messages: [...body().messages, assistantEntry, { role: 'tool', tool_call_id: 'runtime-call', name: 'first', content: 'Local tool result' }] };
  const request = build(input), serialized = JSON.stringify(request.body);
  assert.equal(request.body.params.messages.at(-1).content[0].toolName, 'first');
  assert.equal(request.body.params.messages.at(-2).content[0].toolCallId, 'runtime-call');
  assert.doesNotMatch(serialized, /DO_NOT_SEND_RECEIPT|fixtureLocalReceipt|inlineParsed|rescued|prompt_tokens/);
  assert.equal(assistantEntry.raw, responseRaw, 'local receipts remain available to the caller');
  fails(() => build({ ...input, messages: [...input.messages.slice(0, -1), { ...input.messages.at(-1), name: 'wrong' }] }), 'INVALID_TOOL_HISTORY');
  fails(() => build({ ...input, messages: input.messages.map(message => message === assistantEntry ? { ...message, unknownSemanticControl: true } : message) }), 'UNSUPPORTED_MESSAGE');
});

test('auto/none preserve selection semantics; required/forced/strict/unknown controls are explicit errors', () => {
  assert.equal(build({ ...body(), tools: [tool('first')], tool_choice: 'none' }).body.params.tools.length, 0);
  for (const tool_choice of ['required', { type: 'function', function: { name: 'first' } }]) fails(() => build({ ...body(), tools: [tool('first')], tool_choice }), 'UNSUPPORTED_TOOL_CHOICE');
  fails(() => build({ ...body(), tools: [{ ...tool('first'), function: { ...tool('first').function, strict: true } }] }), 'INVALID_TOOL');
  fails(() => build({ ...body(), tools: {} }), 'INVALID_TOOL');
  for (const field of ['stop', 'parallel_tool_calls', 'response_format', 'thinking', 'top_p']) fails(() => build({ ...body(), [field]: true }), 'UNSUPPORTED_PARAMETER');
});

test('inline images are preserved byte-for-byte with MIME type; unsupported media never becomes text', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const output = build({ ...body(), messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect' }, { type: 'image_url', image_url: { url: image } }] }] }).body.params.messages[0].content;
  assert.deepEqual(output, [{ type: 'text', text: 'Inspect' }, { type: 'image', image, mimeType: 'image/png' }]);
  for (const url of ['https://example.invalid/image.png', 'data:text/html;base64,AAAA']) fails(() => build({ ...body(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] }), 'UNSUPPORTED_IMAGE');
  fails(() => build({ ...body(), messages: [{ role: 'user', content: [{ type: 'input_audio', data: 'fixture' }] }] }), 'UNSUPPORTED_CONTENT');
});

test('reasoning and temperature use only verified fields without expanding max_tokens', () => {
  const result = build({ ...body(), reasoning_effort: 'high', temperature: 0.2 });
  assert.equal(result.body.params.reasoning_effort, 'high'); assert.equal(result.body.params.temperature, 0.2); assert.equal(result.body.params.max_tokens, 128);
  for (const effort of ['low','medium','high','xhigh','max']) assert.equal(build({...body(),reasoning_effort:effort}).body.params.reasoning_effort,effort);
  fails(() => build({ ...body(), reasoning_effort: 'unsupported' }), 'UNSUPPORTED_REASONING');
  fails(() => build({ ...body(), temperature: 10 }), 'INVALID_REQUEST');
});

test('NDJSON chunks reassemble text and reasoning without leaking provider request metadata', () => {
  const events = [{ type: 'start' }, { type: 'start-step', request: { body: { apiKey: 'fixture-echo-must-not-leak' } } },
    { type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', text: 'Think ' }, { type: 'reasoning-delta', id: 'r', text: 'carefully' }, { type: 'reasoning-end', id: 'r' },
    { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', text: '你好' }, { type: 'text-delta', id: 't', text: ' world' }, { type: 'text-end', id: 't' },
    { type: 'finish-step', finishReason: 'stop' }, { type: 'finish', finishReason: 'stop' }, { type: 'provider-metadata', data: { arbitrary: true } }];
  const source = ndjson(events), chunks = [source.slice(0, 17), source.slice(17, 58), source.slice(58)];
  const result = JSON.parse(normalizeCommandCodeResponse(chunks.join(''), { model }));
  assert.equal(result.choices[0].message.content, '你好 world'); assert.equal(result.choices[0].message.reasoning_content, 'Think carefully'); assert.equal(result.usage, undefined);
  assert.equal(JSON.stringify(result).includes('fixture-echo-must-not-leak'), false);
});

test('tool call fragments deduplicate final parsed input and keep each ID/name/JSON across interleaving', () => {
  const result = normalize([{ type: 'tool-input-start', id: 'a', toolName: 'first' }, { type: 'tool-input-start', id: 'b', toolName: 'second' },
    { type: 'tool-input-delta', id: 'a', delta: '{"b":2,' }, { type: 'tool-input-delta', id: 'b', delta: '{"text":"B"}' }, { type: 'tool-input-delta', id: 'a', delta: '"a":1}' },
    { type: 'tool-input-end', id: 'a' }, { type: 'tool-input-end', id: 'b' }, { type: 'tool-call', toolCallId: 'a', toolName: 'first', input: { a: 1, b: 2 } }, { type: 'tool-call', toolCallId: 'b', toolName: 'second', input: { text: 'B' } },
    { type: 'finish', finishReason: 'tool-calls' }]);
  assert.equal(result.choices[0].finish_reason, 'tool_calls'); assert.deepEqual(result.choices[0].message.tool_calls.map(call => [call.id, call.function.name, JSON.parse(call.function.arguments)]), [['a', 'first', { a: 1, b: 2 }], ['b', 'second', { text: 'B' }]]);
});

test('input is inclusive of cached tokens and reasoning is not added to total output a second time', () => {
  const usage = { inputTokens: 100, outputTokens: 15, totalTokens: 115, cachedInputTokens: 70, inputTokenDetails: { noCacheTokens: 30, cacheReadTokens: 70 }, outputTokenDetails: { reasoningTokens: 9 }, raw: { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115, prompt_cache_hit_tokens: 70, completion_tokens_details: { reasoning_tokens: 9 } } };
  assert.deepEqual(normalize(textEvents({ totalUsage: usage })).usage, { prompt_tokens: 100, completion_tokens: 15, total_tokens: 115, prompt_tokens_details: { cached_tokens: 70 }, completion_tokens_details: { reasoning_tokens: 9 } });
});

test('missing or partial usage stays missing or partial; actual raw counters may be used', () => {
  assert.equal(normalize(textEvents()).usage, undefined);
  assert.deepEqual(normalize(textEvents({ totalUsage: { outputTokens: 4 } })).usage, { completion_tokens: 4 });
  assert.deepEqual(normalize(textEvents({ totalUsage: { raw: { prompt_tokens: 8, completion_tokens: 2 } } })).usage, { prompt_tokens: 8, completion_tokens: 2 });
  assert.deepEqual(normalize(textEvents({ totalUsage: {} })).usage, {});
  const events = textEvents(); events.at(-2).usage = { inputTokens: 100, outputTokens: 10 };
  assert.equal(normalize(events).usage, undefined, 'step counts never manufacture a final usage total');
});

test('a contradictory final zero cannot erase actual step usage or cached/reasoning counts', () => {
  const events = textEvents({ totalUsage: { inputTokens: 0, outputTokens: 0 } }); events.at(-2).usage = { inputTokens: 100, outputTokens: 10 };
  fails(() => normalize(events), 'INVALID_USAGE');
  events.at(-1).totalUsage = { inputTokens: 100, outputTokens: 10 };
  assert.deepEqual(normalize(events).usage, { prompt_tokens: 100, completion_tokens: 10 });
  events.at(-1).usage = { inputTokens: 0, outputTokens: 0 };
  fails(() => normalize(events), 'INVALID_USAGE'); delete events.at(-1).usage;
  const multiple = [
    ...events.slice(0, -1), { type: 'start-step' }, { type: 'finish-step', usage: { inputTokens: 20, outputTokens: 2 }, finishReason: 'stop' },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 100, outputTokens: 10 } }
  ];
  fails(() => normalize(multiple), 'INVALID_USAGE');
  multiple.at(-1).totalUsage = { inputTokens: 120, outputTokens: 12 };
  assert.deepEqual(normalize(multiple).usage, { prompt_tokens: 120, completion_tokens: 12 });
  multiple.at(-1).totalUsage = { inputTokens: 121, outputTokens: 12 };
  fails(() => normalize(multiple), 'INVALID_USAGE');
});

test('a complete reasoning-only capped response retains actual usage for settlement', () => {
  const result = normalize([{ type: 'reasoning-start', id: 'r' }, { type: 'reasoning-delta', id: 'r', text: 'reasoning only' }, { type: 'reasoning-end', id: 'r' },
    { type: 'finish', finishReason: 'length', totalUsage: { inputTokens: 10, outputTokens: 32, totalTokens: 42, reasoningTokens: 32 } }]);
  assert.equal(result.choices[0].message.content, null); assert.equal(result.choices[0].message.reasoning_content, 'reasoning only'); assert.equal(result.choices[0].finish_reason, 'length');
  assert.equal(result.usage.completion_tokens, 32); assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 32);
});

test('positive cache-write usage has no approved quote and never settles as a cache-read or zero', () => {
  for (const totalUsage of [{ inputTokens: 10, outputTokens: 1, cacheWriteTokens: 2 }, { inputTokenDetails: { cacheWriteTokens: 2 } }, { raw: { cache_creation_input_tokens: 2 } }, { raw: { cache_creation: { ephemeral_1h_input_tokens: 2 } } }]) fails(() => normalize(textEvents({ totalUsage })), 'UNPRICED_CACHE_WRITE');
  assert.deepEqual(normalize(textEvents({ totalUsage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0 } })).usage, { prompt_tokens: 1, completion_tokens: 1 });
});

test('invalid/contradictory counts fail; no numeric coercion or negative clamping', () => {
  for (const totalUsage of [{ inputTokens: '10' }, { inputTokens: -1 }, { inputTokens: 1.5 }, { inputTokens: 10, outputTokens: 2, totalTokens: 5 }, { inputTokens: 10, inputTokenDetails: { cacheReadTokens: 11 } }, { inputTokens: 10, cachedInputTokens: 3, inputTokenDetails: { cacheReadTokens: 2 } }, { outputTokens: 2, reasoningTokens: 3 }]) fails(() => normalize(textEvents({ totalUsage })), 'INVALID_USAGE');
});

test('HTTP 403 and 429 response payloads remain errors and are neither normalized nor redacted into fake success', () => {
  for (const [status, code] of [[403, 'upgrade_required'], [429, 'rate_limit_exceeded']]) {
    const source = JSON.stringify({ error: { code, message: 'Fixture provider denial' } }); assert.equal(normalizeCommandCodeResponse(source, { model, status }), source);
  }
});

test('error/abort/unknown or refusal finish never become a successful completion', () => {
  for (const event of [{ type: 'error', error: { message: 'fixture-hidden-provider-detail' } }, { type: 'abort' }]) fails(() => normalize([event]), 'PROVIDER_ERROR');
  for (const finishReason of ['network-error', 'connection_error', 'abort', 'refusal', 'invented-stop']) fails(() => normalize(textEvents({ finishReason })), 'PROVIDER_ERROR');
  fails(() => normalize(textEvents({ finishReason: 'stop', rawFinishReason: 'upstream-error' })), 'PROVIDER_ERROR');
});

test('malformed JSON, truncated blocks and missing terminal finish are never silent success', () => {
  fails(() => normalizeCommandCodeResponse('{"type":', { model }), 'INVALID_STREAM');
  fails(() => normalize(textEvents().slice(0, -1)), 'TRUNCATED');
  fails(() => normalize([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', text: 'partial' }, { type: 'finish', finishReason: 'stop' }]), 'TRUNCATED');
  fails(() => normalize([{ type: 'tool-input-start', id: 'a', toolName: 'first' }, { type: 'tool-input-delta', id: 'a', delta: '{' }, { type: 'finish', finishReason: 'tool-calls' }]), 'TRUNCATED');
  fails(() => normalize([...textEvents(), { type: 'text-delta', id: 'txt-0', text: 'after finish' }]), 'INVALID_STREAM');
});

test('unknown response protocol, remote tool results and unexpected model fail closed', () => {
  fails(() => normalize([{ type: 'unknown-version-event' }]), 'UNKNOWN_PROTOCOL');
  fails(() => normalize([{ type: 'tool-result', toolCallId: 'remote' }]), 'UNKNOWN_PROTOCOL');
  fails(() => normalizeCommandCodeResponse('data: {"type":"finish"}\n', { model }), 'INVALID_STREAM');
  fails(() => normalize(textEvents({ model: 'unapproved-model' })), 'MODEL_MISMATCH');
});

test('only approved response aliases are accepted and the actual reported model is retained', () => {
  const alias = 'deepseek-v4.1-flash-approved-snapshot', events = textEvents({ modelId: alias });
  fails(() => normalize(events), 'MODEL_MISMATCH');
  assert.equal(normalize(events, { responseModels: [alias] }).model, alias);
  assert.equal(normalize(textEvents(), { responseModels: [alias] }).model, model);
  const conflict = [{ type: 'start', model }, ...events];
  fails(() => normalize(conflict, { responseModels: [alias] }), 'MODEL_MISMATCH');
  fails(() => normalize(textEvents({ model, modelId: alias }), { responseModels: [alias] }), 'MODEL_MISMATCH');
});

test('oversized input and output are rejected before protocol processing', () => {
  fails(() => build({ ...body(), messages: [{ role: 'user', content: 'x'.repeat(COMMANDCODE_REQUEST_LIMIT + 1) }] }), 'INPUT_TOO_LARGE');
  fails(() => normalizeCommandCodeResponse('x'.repeat(COMMANDCODE_RESPONSE_LIMIT + 1), { model }), 'RESPONSE_TOO_LARGE');
});

test('known output-cap termination preserves length; tool calls cannot masquerade as stop', () => {
  assert.equal(normalize(textEvents({ finishReason: 'length' })).choices[0].finish_reason, 'length');
  fails(() => normalize([{ type: 'tool-call', toolCallId: 'a', toolName: 'first', input: {} }, { type: 'finish', finishReason: 'stop' }]), 'INVALID_STREAM');
  fails(() => normalize(textEvents({ finishReason: 'tool-calls' })), 'INVALID_STREAM');
});
