import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createConversationContext, conversationResourceId, runWithConversationContext,
  currentConversationContext, requireConversationContext,
} from '../src/conversation-context.js';

const input = (patch = {}) => ({ botId: 'primary', conversationKey: 'group:12345', actorId: 'qq:23456',
  fundingRef: { id: 'fixture-funding', version: 1 }, personaRef: { id: 'fixture-persona', version: 2 }, ...patch });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('complete group/private identities stay separate even when numeric targets match', () => {
  const group = createConversationContext(input()), person = createConversationContext(input({ conversationKey: 'private:12345' }));
  assert.notEqual(group.requestId, person.requestId);
  assert.equal(conversationResourceId(group), 'primary/group:12345');
  assert.equal(conversationResourceId(person), 'primary/private:12345');
  assert.notEqual(conversationResourceId(group), conversationResourceId(input({ botId: 'other' })));
});

test('changing managers or funding never creates a second identity for the same group', () => {
  const first = input(), second = input({ actorId: 'qq:34567', fundingRef: { id: 'fixture-other-funding', version: 3 } });
  assert.equal(conversationResourceId(first), conversationResourceId(second));
});

test('context accepts verified references, rejects credentials, role switches and malformed scopes', () => {
  for (const patch of [{ apiKey: 'fixture-secret' }, { role: 'admin' }, { conversationKey: '12345' },
    { botId: 123 }, { conversationKey: ['group:12345'] },
    { conversationKey: 'private:012345' }, { conversationKey: 'group:9007199254740992' }, { actorId: '' },
    { fundingRef: { id: 'fixture', version: 0 } }, { fundingRef: { id: 'fixture', version: 1, apiKey: 'fixture-secret' } },
    { personaRef: { id: 'fixture', version: '1' } }, { requestId: null }]) {
    assert.throws(() => createConversationContext(input(patch)), { code: 'INVALID_CONVERSATION_CONTEXT' });
  }
});

test('a caller cannot mutate captured references after another task has started', async () => {
  const original = input();
  await runWithConversationContext(original, async () => {
    original.fundingRef.id = 'fixture-changed'; original.personaRef.version++;
    await delay(1);
    const scope = requireConversationContext();
    assert.equal(scope.fundingRef.id, 'fixture-funding'); assert.equal(scope.personaRef.version, 2);
    assert.ok(Object.isFrozen(scope) && Object.isFrozen(scope.fundingRef) && Object.isFrozen(scope.personaRef));
    assert.throws(() => { scope.fundingRef.id = 'fixture-forged'; }, TypeError);
  });
});

test('parallel groups, payers and private messages cannot overwrite one another through async work', async () => {
  const values = [input(), input({ conversationKey: 'group:34567', fundingRef: { id: 'fixture-second', version: 2 } }),
    input({ conversationKey: 'private:12345', fundingRef: { id: 'fixture-private', version: 1 } })];
  await Promise.all(values.map((value, index) => runWithConversationContext(value, async () => {
    const before = requireConversationContext();
    await delay(8 - index * 2); await Promise.resolve();
    assert.equal(requireConversationContext(), before);
    assert.equal(before.conversationKey, value.conversationKey); assert.equal(before.fundingRef.id, value.fundingRef.id);
  })));
  assert.equal(currentConversationContext(), null);
});

test('nested work restores its parent context after errors', async () => {
  await runWithConversationContext(input(), async () => {
    const outer = requireConversationContext();
    await assert.rejects(runWithConversationContext(input({ conversationKey: 'private:23456' }), async () => {
      await delay(1); throw new Error('fixture failure');
    }), /fixture failure/);
    assert.equal(requireConversationContext(), outer);
  });
  assert.equal(currentConversationContext(), null);
});

test('unscoped work cannot silently select a platform payer', () => {
  assert.throws(requireConversationContext, { code: 'CONVERSATION_CONTEXT_REQUIRED' });
  runWithConversationContext(input(), () => assert.equal(requireConversationContext().actorId, 'qq:23456'));
  assert.throws(requireConversationContext, { code: 'CONVERSATION_CONTEXT_REQUIRED' });
});
