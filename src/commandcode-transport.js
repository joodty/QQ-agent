/*
 * Command Code generate protocol interoperability, informed by:
 * https://github.com/eibednejo/dsh-llm-commandcode (MIT)
 * https://github.com/Victor-770/dsh-commandcode-provider (MIT)
 *
 * Copyright (c) 2026 eibednejo
 * Copyright (c) 2026 dsh-commandcode-provider contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Official command-code@1.88.0 and @1.53.0 npm cli.mjs were read without execution:
 * complete() sends params.max_tokens from its maxOutputTokens option, default
 * 64000. This is a verified protocol field, not an invented cap. Runtime cap
 * enforcement/account access must still be checked by the paid-call boundary.
 * No official CLI implementation is copied or executed by this module.
 */

export const COMMANDCODE_PROTOCOL_VERSION = '1.88.0';
export const COMMANDCODE_REQUEST_LIMIT = 8 * 1024 * 1024;
export const COMMANDCODE_RESPONSE_LIMIT = 16 * 1024 * 1024;
const BASE_URL = 'https://api.commandcode.ai/alpha';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fail = (code, message) => Object.assign(new Error(message), { code: 'COMMANDCODE_' + code });
const assert = (condition, code, message) => { if (!condition) throw fail(code, message); };
const fields = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
const name = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function jsonClone(value, limit = COMMANDCODE_REQUEST_LIMIT) {
  let text;
  try { text = JSON.stringify(value); } catch { throw fail('INVALID_REQUEST', 'Command Code request must be finite JSON'); }
  assert(typeof text === 'string' && Buffer.byteLength(text) <= limit, 'INPUT_TOO_LARGE', 'Command Code payload exceeds the transport size limit');
  return JSON.parse(text);
}
function textParts(content, { image = false, nullable = false } = {}) {
  if (content == null && nullable) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  assert(Array.isArray(content), 'UNSUPPORTED_CONTENT', 'Command Code message content must be text or supported image parts');
  return content.map(part => {
    if (fields(part, ['type', 'text']) && part.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (image && fields(part, ['type', 'image_url']) && part.type === 'image_url' && fields(part.image_url, ['url', 'detail'])) {
      const source = part.image_url.url;
      assert(typeof source === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(source), 'UNSUPPORTED_IMAGE', 'Command Code image transport requires an inline base64 image; no image is downloaded or replaced');
      assert(part.image_url.detail === undefined || part.image_url.detail === 'auto', 'UNSUPPORTED_IMAGE', 'Command Code has no verified image-detail control');
      return { type: 'image', image: source, mimeType: source.slice(5, source.indexOf(';')) };
    }
    throw fail('UNSUPPORTED_CONTENT', 'Command Code cannot preserve this content part');
  });
}
function argumentsObject(raw) {
  assert(typeof raw === 'string', 'INVALID_TOOL', 'Tool arguments must be JSON text');
  let value; try { value = JSON.parse(raw); } catch { throw fail('INVALID_TOOL', 'Tool arguments contain incomplete JSON'); }
  assert(object(value), 'INVALID_TOOL', 'Tool arguments must be a JSON object'); return value;
}

/** Pure conversion of an already quoted/constrained canonical OpenAI request.
 * No credential lookup, network, retries, filesystem, clock or random values. */
export function buildCommandCodeRequest({ api, body } = {}) {
  assert(api?.transport === 'commandcode-generate' && api.baseUrl === BASE_URL, 'INVALID_ENDPOINT', 'Command Code generate requires its exact HTTPS alpha endpoint');
  assert(typeof api.apiKey === 'string' && /^[^\s\x00-\x1f\x7f]{1,4096}$/.test(api.apiKey), 'MISSING_CREDENTIAL', 'Command Code requires an explicitly resolved credential');
  // Orchestrator keeps the provider receipt on assistantEntry.raw for local
  // diagnostics; UI shadow records may also carry parser/rescue flags. These
  // are never model input, and are removed before sizing or serialization.
  const localFields = new Set(['raw', 'inlineParsed', 'rescued']);
  const source = object(body) && Array.isArray(body.messages) ? { ...body, messages: body.messages.map(message => object(message)
    ? Object.fromEntries(Object.keys(message).filter(key => !localFields.has(key)).map(key => [key, message[key]])) : message) } : body;
  const input = jsonClone(source);
  assert(fields(input, ['model', 'messages', 'tools', 'tool_choice', 'max_tokens', 'stream', 'temperature', 'reasoning_effort', 'n', 'modalities']), 'UNSUPPORTED_PARAMETER', 'Command Code request contains an unsupported parameter');
  assert(typeof input.model === 'string' && input.model.length > 0 && input.model === api.model && input.model.length <= 200, 'MODEL_MISMATCH', 'Command Code must preserve the approved model');
  assert(Number.isSafeInteger(input.max_tokens) && input.max_tokens > 0 && input.max_tokens <= 64000, 'OUTPUT_CAP', 'Command Code requires a quoted max_tokens between 1 and 64000');
  assert(input.stream === false && (input.n === undefined || input.n === 1) && (input.modalities === undefined || JSON.stringify(input.modalities) === '["text"]'), 'UNSUPPORTED_PARAMETER', 'Command Code accepts one canonical buffered text completion');
  assert(Array.isArray(input.messages) && input.messages.length > 0 && input.messages.length <= 10000, 'INVALID_REQUEST', 'Command Code messages are missing or oversized');
  assert(input.tool_choice === undefined || ['auto', 'none'].includes(input.tool_choice), 'UNSUPPORTED_TOOL_CHOICE', 'Command Code has no verified forced/required tool-choice field');
  if (input.temperature !== undefined) assert(Number.isFinite(input.temperature) && input.temperature >= 0 && input.temperature <= 2, 'INVALID_REQUEST', 'Invalid Command Code temperature');
  if (input.reasoning_effort !== undefined) assert(['low', 'high', 'max'].includes(input.reasoning_effort), 'UNSUPPORTED_REASONING', 'Command Code reasoning effort must use its verified vocabulary');
  assert(input.tools === undefined || Array.isArray(input.tools), 'INVALID_TOOL', 'Command Code tools must be an array');
  const tools = (input.tools || []).map(tool => {
    assert(fields(tool, ['type', 'function']) && tool.type === 'function' && fields(tool.function, ['name', 'description', 'parameters', 'strict'])
      && name(tool.function.name) && (tool.function.description === undefined || typeof tool.function.description === 'string')
      && (tool.function.parameters === undefined || object(tool.function.parameters)) && tool.function.strict !== true, 'INVALID_TOOL', 'Command Code requires supported function tools and JSON Schema');
    return { name: tool.function.name, description: tool.function.description || '', input_schema: tool.function.parameters || {} };
  });
  assert(new Set(tools.map(tool => tool.name)).size === tools.length, 'INVALID_TOOL', 'Duplicate function tool names');
  const system = [], messages = [], pending = new Map(), seen = new Set();
  for (const message of input.messages) {
    assert(fields(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'reasoning_content', 'name']), 'UNSUPPORTED_MESSAGE', 'Command Code cannot preserve these message fields');
    if (message.role === 'system') { assert(message.tool_calls === undefined && message.tool_call_id === undefined && message.reasoning_content === undefined && message.name === undefined, 'INVALID_MESSAGE', 'Invalid system tool fields'); system.push(textParts(message.content).map(part => part.text).join('')); continue; }
    if (message.role === 'tool') {
      assert(identifier(message.tool_call_id) && pending.has(message.tool_call_id) && message.tool_calls === undefined && message.reasoning_content === undefined, 'INVALID_TOOL_HISTORY', 'Tool result does not match an outstanding assistant tool call');
      assert(message.name === undefined || message.name === pending.get(message.tool_call_id), 'INVALID_TOOL_HISTORY', 'Tool result name disagrees with its assistant call');
      const parts = textParts(message.content);
      messages.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: message.tool_call_id, toolName: pending.get(message.tool_call_id), output: { type: 'text', value: parts.map(part => part.text).join('') } }] });
      pending.delete(message.tool_call_id); continue;
    }
    assert(pending.size === 0, 'INVALID_TOOL_HISTORY', 'A tool call is missing its result; history is never silently repaired');
    if (message.role === 'user') { assert(message.tool_calls === undefined && message.tool_call_id === undefined && message.reasoning_content === undefined && message.name === undefined, 'INVALID_MESSAGE', 'Invalid user tool/reasoning fields'); messages.push({ role: 'user', content: textParts(message.content, { image: true }) }); continue; }
    assert(message.role === 'assistant' && message.tool_call_id === undefined && message.name === undefined, 'UNSUPPORTED_ROLE', 'Command Code supports system, user, assistant and tool roles');
    const parts = textParts(message.content, { nullable: true });
    if (message.reasoning_content !== undefined) { assert(typeof message.reasoning_content === 'string', 'UNSUPPORTED_CONTENT', 'Assistant reasoning must be text'); parts.push({ type: 'reasoning', text: message.reasoning_content }); }
    if (message.tool_calls !== undefined) {
      assert(Array.isArray(message.tool_calls) && message.tool_calls.length <= 128, 'INVALID_TOOL', 'Invalid assistant tool calls');
      for (const call of message.tool_calls) {
        assert(fields(call, ['id', 'type', 'function']) && identifier(call.id) && !seen.has(call.id) && call.type === 'function' && fields(call.function, ['name', 'arguments']) && name(call.function.name), 'INVALID_TOOL', 'Invalid or duplicate assistant tool call');
        seen.add(call.id); pending.set(call.id, call.function.name); parts.push({ type: 'tool-call', toolCallId: call.id, toolName: call.function.name, input: argumentsObject(call.function.arguments) });
      }
    }
    messages.push({ role: 'assistant', content: parts });
  }
  assert(pending.size === 0, 'INVALID_TOOL_HISTORY', 'A tool call is missing its result; no synthetic result is inserted');
  const params = { model: input.model, messages, tools: input.tool_choice === 'none' ? [] : tools, system: system.join('\n\n'), max_tokens: input.max_tokens, stream: true };
  if (input.temperature !== undefined) params.temperature = input.temperature;
  if (input.reasoning_effort !== undefined) params.reasoning_effort = input.reasoning_effort;
  const payload = { config: { workingDir: '', date: '', environment: 'qq-agent/0.4.0', structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [] }, memory: null, taste: null, skills: null, permissionMode: 'standard', params };
  jsonClone(payload);
  return { url: BASE_URL + '/generate', headers: { authorization: 'Bearer ' + api.apiKey, 'content-type': 'application/json', 'user-agent': 'qq-agent/0.4.0', 'x-command-code-version': COMMANDCODE_PROTOCOL_VERSION }, body: payload };
}

function normalizeUsage(value) {
  assert(object(value), 'INVALID_USAGE', 'Command Code usage is not an object');
  const output = {}, details = value.inputTokenDetails || {}, raw = value.raw || {}, completionDetails = value.outputTokenDetails || {};
  assert(object(details) && object(raw) && object(completionDetails), 'INVALID_USAGE', 'Command Code token details are invalid');
  for (const source of [value.cacheWriteTokens, value.cacheWriteTokens1h, value.cacheCreationInputTokens, value.cache_creation_input_tokens, details.cacheWriteTokens, details.cacheCreationTokens, raw.cache_creation_input_tokens, raw.cache_creation?.ephemeral_1h_input_tokens, raw.cache_creation?.ephemeral_5m_input_tokens, raw.prompt_tokens_details?.cache_write_tokens]) {
    if (source === undefined) continue;
    assert(integer(source), 'INVALID_USAGE', 'Command Code cache-write usage is invalid');
    assert(source === 0, 'UNPRICED_CACHE_WRITE', 'Command Code cache-write tokens have no approved price; retain unknown usage');
  }
  function count(values) {
    const supplied = values.filter(item => item !== undefined);
    if (!supplied.length) return undefined;
    assert(supplied.every(integer) && supplied.every(item => item === supplied[0]), 'INVALID_USAGE', 'Command Code usage counters are invalid or contradictory'); return supplied[0];
  }
  const input = count([value.inputTokens, raw.prompt_tokens]), tokens = count([value.outputTokens, raw.completion_tokens]), total = count([value.totalTokens, raw.total_tokens]);
  const cached = count([details.cacheReadTokens, value.cachedInputTokens, raw.prompt_cache_hit_tokens, raw.prompt_tokens_details?.cached_tokens]);
  const uncached = count([details.noCacheTokens, raw.prompt_cache_miss_tokens]);
  const reasoning = count([value.reasoningTokens, completionDetails.reasoningTokens, raw.completion_tokens_details?.reasoning_tokens]);
  if (input !== undefined) output.prompt_tokens = input;
  if (tokens !== undefined) output.completion_tokens = tokens;
  if (total !== undefined) output.total_tokens = total;
  if (cached !== undefined) output.prompt_tokens_details = { cached_tokens: cached };
  if (reasoning !== undefined) output.completion_tokens_details = { reasoning_tokens: reasoning };
  assert(input === undefined || cached === undefined || cached <= input, 'INVALID_USAGE', 'Cached tokens exceed total input');
  assert(input === undefined || uncached === undefined || cached === undefined || uncached + cached === input, 'INVALID_USAGE', 'Cached and uncached counters disagree with input total');
  assert(tokens === undefined || reasoning === undefined || reasoning <= tokens, 'INVALID_USAGE', 'Reasoning tokens exceed total output');
  assert(input === undefined || tokens === undefined || total === undefined || input + tokens === total, 'INVALID_USAGE', 'Input and output counters disagree with total');
  return output;
}

/** Buffer-to-buffer protocol normalization. A missing terminal finish, malformed
 * fragment, provider error or unknown protocol never becomes a successful chat. */
export function normalizeCommandCodeResponse(text, { model, status = 200, responseModels = [] } = {}) {
  assert(typeof text === 'string' && Buffer.byteLength(text) <= COMMANDCODE_RESPONSE_LIMIT, 'RESPONSE_TOO_LARGE', 'Command Code response exceeds the transport size limit');
  if (status < 200 || status >= 300) return text;
  assert(typeof model === 'string' && model.length > 0, 'MODEL_MISMATCH', 'Command Code response requires the approved model identity');
  assert(Array.isArray(responseModels) && responseModels.length <= 100 && responseModels.every(value => typeof value === 'string' && value.length > 0 && value.length <= 200), 'MODEL_MISMATCH', 'Command Code approved response aliases are invalid');
  const approvedModels = new Set([model, ...responseModels]);
  const blocks = new Map(), order = []; let terminal = null, finishStep = null, stepUsage = [], stepOpen = false, actualModel;
  function block(kind, id, { create = false } = {}) {
    assert(identifier(id), 'INVALID_STREAM', 'Command Code block identifier is missing');
    const key = kind + ':' + id; let value = blocks.get(key);
    if (!value && create) { assert(blocks.size < 2048, 'RESPONSE_TOO_LARGE', 'Command Code has too many content blocks'); value = { kind, id, text: '', closed: false }; blocks.set(key, value); order.push(value); }
    assert(value, 'INVALID_STREAM', 'Command Code delta references an unknown block'); return value;
  }
  const lines = text.split('\n'); assert(lines.length <= 100000, 'RESPONSE_TOO_LARGE', 'Command Code has too many stream events');
  for (const line of lines) {
    if (!line.trim()) continue;
    assert(Buffer.byteLength(line) <= 2 * 1024 * 1024, 'RESPONSE_TOO_LARGE', 'Command Code stream event is too large');
    let event; try { event = JSON.parse(line); } catch { throw fail('INVALID_STREAM', 'Command Code stream contains malformed or truncated JSON'); }
    assert(object(event) && typeof event.type === 'string', 'UNKNOWN_PROTOCOL', 'Command Code stream event has no recognized type');
    assert(!terminal || event.type === 'provider-metadata', 'INVALID_STREAM', 'Command Code emitted content after its terminal event');
    if (event.model !== undefined || event.modelId !== undefined) {
      const reported = event.model ?? event.modelId;
      assert(approvedModels.has(reported) && (event.model === undefined || event.modelId === undefined || event.model === event.modelId)
        && (actualModel === undefined || actualModel === reported), 'MODEL_MISMATCH', 'Command Code returned an unexpected or conflicting model');
      actualModel = reported;
    }
    const type = event.type;
    if (type === 'error' || type === 'abort') throw fail('PROVIDER_ERROR', 'Command Code reported an incomplete or rejected generation');
    if (['start', 'provider-metadata'].includes(type)) continue;
    if (type === 'start-step') { assert(!stepOpen, 'INVALID_STREAM', 'Command Code started an unfinished step'); stepOpen = true; continue; }
    if (type === 'finish-step') {
      if (event.usage !== undefined) stepUsage.push(normalizeUsage(event.usage));
      finishStep = event; stepOpen = false; continue;
    }
    if (type === 'finish') { terminal = event; continue; }
    if (['text-start', 'reasoning-start', 'tool-input-start'].includes(type)) {
      const kind = type === 'text-start' ? 'text' : type === 'reasoning-start' ? 'reasoning' : 'tool';
      assert(!blocks.has(kind + ':' + event.id), 'INVALID_STREAM', 'Command Code repeated a block start');
      const value = block(kind, event.id, { create: true }); if (kind === 'tool') { assert(name(event.toolName), 'INVALID_TOOL', 'Command Code tool name is invalid'); value.name = event.toolName; } continue;
    }
    if (['text-delta', 'reasoning-delta', 'tool-input-delta'].includes(type)) {
      const kind = type === 'text-delta' ? 'text' : type === 'reasoning-delta' ? 'reasoning' : 'tool', delta = kind === 'tool' ? event.delta : event.text;
      assert(typeof delta === 'string', 'INVALID_STREAM', 'Command Code content delta is not text');
      const value = block(kind, event.id, { create: kind !== 'tool' }); assert(!value.closed && !value.inputEnded, 'INVALID_STREAM', 'Command Code appended to a closed block'); value.text += delta; continue;
    }
    if (['text-end', 'reasoning-end', 'tool-input-end'].includes(type)) {
      const kind = type === 'text-end' ? 'text' : type === 'reasoning-end' ? 'reasoning' : 'tool', value = block(kind, event.id);
      assert(!value.closed && !value.inputEnded, 'INVALID_STREAM', 'Command Code repeated a block end'); if (kind === 'tool') value.inputEnded = true; else value.closed = true; continue;
    }
    if (type === 'tool-call') {
      const id = event.toolCallId ?? event.id, value = block('tool', id, { create: true });
      assert(!value.closed && name(event.toolName) && (!value.name || value.name === event.toolName), 'INVALID_TOOL', 'Command Code tool call is duplicate or contradictory');
      const args = event.input === undefined ? argumentsObject(value.text) : event.input;
      assert(object(args), 'INVALID_TOOL', 'Command Code tool input is not an object');
      const stable = value => JSON.stringify(value, (_key, child) => object(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
      if (value.text) assert(stable(argumentsObject(value.text)) === stable(args), 'INVALID_TOOL', 'Command Code tool deltas disagree with completed arguments');
      value.name = event.toolName; value.arguments = JSON.stringify(args); value.closed = true; continue;
    }
    throw fail('UNKNOWN_PROTOCOL', 'Command Code returned an unsupported stream event');
  }
  assert(terminal && !stepOpen, 'TRUNCATED', 'Command Code stream ended before its final finish event');
  const reason = terminal.finishReason ?? terminal.rawFinishReason ?? finishStep?.finishReason;
  const rawReason = terminal.rawFinishReason ?? finishStep?.rawFinishReason;
  assert(rawReason === undefined || !/error|abort|cancel|disconnect|refus/i.test(String(rawReason)), 'PROVIDER_ERROR', 'Command Code generation did not complete');
  const reasons = { stop: 'stop', 'tool-calls': 'tool_calls', tool_calls: 'tool_calls', length: 'length', 'max-tokens': 'length', max_tokens: 'length', max_output_tokens: 'length' };
  assert(Object.hasOwn(reasons, reason), 'PROVIDER_ERROR', 'Command Code returned an unsupported completion reason');
  assert(order.length > 0 && order.every(value => value.closed), 'TRUNCATED', 'Command Code stream contains incomplete content blocks');
  const tools = order.filter(value => value.kind === 'tool').map(value => ({ id: value.id, type: 'function', function: { name: value.name, arguments: value.arguments } }));
  assert(!tools.length || reasons[reason] === 'tool_calls', 'INVALID_STREAM', 'Command Code tool calls lack their tool completion reason');
  assert(reasons[reason] !== 'tool_calls' || tools.length > 0, 'INVALID_STREAM', 'Command Code tool completion contains no tool call');
  const message = { role: 'assistant', content: order.filter(value => value.kind === 'text').map(value => value.text).join('') || null };
  const reasoning = order.filter(value => value.kind === 'reasoning').map(value => value.text).join(''); if (reasoning) message.reasoning_content = reasoning;
  if (tools.length) message.tool_calls = tools;
  const result = { object: 'chat.completion', model: actualModel ?? model, choices: [{ index: 0, message, finish_reason: reasons[reason] }] };
  if (terminal.totalUsage !== undefined || terminal.usage !== undefined) {
    const totalUsage = normalizeUsage(terminal.totalUsage ?? terminal.usage);
    if (terminal.totalUsage !== undefined && terminal.usage !== undefined) {
      assert(JSON.stringify(totalUsage) === JSON.stringify(normalizeUsage(terminal.usage)), 'INVALID_USAGE', 'Command Code final usage summaries disagree');
    }
    for (const path of [['prompt_tokens'], ['completion_tokens'], ['total_tokens'], ['prompt_tokens_details', 'cached_tokens'], ['completion_tokens_details', 'reasoning_tokens']]) {
      const get = value => path.reduce((current, key) => current?.[key], value), finalCount = get(totalUsage);
      if (finalCount === undefined || !stepUsage.length) continue;
      const known = stepUsage.map(get).filter(value => value !== undefined), lowerBound = known.reduce((sum, value) => sum + value, 0);
      assert(Number.isSafeInteger(lowerBound) && finalCount >= lowerBound && (known.length !== stepUsage.length || finalCount === lowerBound), 'INVALID_USAGE', 'Command Code step usage contradicts the final usage summary');
    }
    result.usage = totalUsage;
  }
  // Per-step usage is not promoted to an authoritative final total. If the
  // terminal event omits usage, leave it absent so the ledger remains unknown.
  return JSON.stringify(result);
}
