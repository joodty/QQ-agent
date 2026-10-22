import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const requests = new AsyncLocalStorage();
const fields = ['botId', 'conversationKey', 'actorId', 'fundingRef', 'personaRef', 'requestId'];
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const invalid = () => Object.assign(new Error('Invalid trusted conversation context'), { code: 'INVALID_CONVERSATION_CONTEXT' });

function reference(value) {
  if (!exact(value, ['id', 'version']) || !identifier(value.id)
      || !Number.isSafeInteger(value.version) || value.version < 1) throw invalid();
  return Object.freeze({ id: value.id, version: value.version });
}

/** Metadata for server-resolved work. This carries no credentials and grants no permission. */
export function createConversationContext(input) {
  if (!exact(input, fields) || typeof input.botId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.botId)
      || typeof input.conversationKey !== 'string' || !/^(group|private):[1-9]\d{0,15}$/.test(input.conversationKey)
      || !Number.isSafeInteger(Number(input.conversationKey.split(':')[1]))
      || !identifier(input.actorId) || input.requestId !== undefined && !identifier(input.requestId)) throw invalid();
  return Object.freeze({
    botId: input.botId,
    conversationKey: input.conversationKey,
    actorId: input.actorId,
    fundingRef: reference(input.fundingRef),
    personaRef: reference(input.personaRef),
    requestId: input.requestId ?? randomUUID(),
  });
}

/** Group identity is independent of its managers, payer, persona and model. */
export function conversationResourceId(context) {
  const value = createConversationContext(context);
  return value.botId + '/' + value.conversationKey;
}

export function runWithConversationContext(input, work) {
  if (typeof work !== 'function') throw new TypeError('Conversation work must be a function');
  return requests.run(createConversationContext(input), work);
}

export function currentConversationContext() {
  return requests.getStore() ?? null;
}

export function requireConversationContext() {
  const context = currentConversationContext();
  if (!context) throw Object.assign(new Error('Conversation context required; do not assume a platform payer'), { code: 'CONVERSATION_CONTEXT_REQUIRED' });
  return context;
}
