import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDCODE_GO_MODELS as models,
  COMMANDCODE_GO_CATALOG_SOURCE as source,
  COMMANDCODE_GO_USD_TO_CNY,
  getApprovedCommandCodeGoModels,
} from '../src/commandcode-go-models.js';

const row = id => {
  const value = models.find(model => model.id === id);
  assert.ok(value, `missing official Go model: ${id}`);
  return value;
};

test('snapshot includes exactly the current official Go membership, excluding hidden CLI entries', () => {
  const ids = `moonshotai/Kimi-K3.1-Pro
ornith/ornith-1.5-122b
minimax/minimax-m3.1-flash
reflection/beam:free
meta/muse-spark-open
nvidia/nemotron-3.5-super-vl
inclusionai/ling-3.1-flash
stealth/glyph-cluster:free
mistral/mistral-large-4
deepseek/deepseek-v4.1-flash-fast
gpt-6-luna
xiaomi/mimo-v2.6-flash
xiaomi/mimo-v2.6-pro
stepfun/Step-5-Preview
z-ai/glm-5.3-flashx
Qwen/Qwen3.8-Omni-Flash
deepseek/deepseek-v4.1-flash
meta/muse-spark-1.3-contributor
Qwen/Qwen3.8-Max-0902
tencent/hy4-preview
z-ai/glm-5.3-flash
meituan/LongCat-2.0
Qwen/Qwen3.8-Flash
deepseek/deepseek-v4-flash-fast
deepseek/deepseek-v4-flash-vision-exp
zai-org/GLM-5.3
Qwen/Qwen3.8-27B
deepseek/deepseek-v4-pro
meta/muse-spark-1.2-contributor
Qwen/Qwen3.8-Max
deepseek/deepseek-v4-flash
thinkingmachines/inkling-small
Qwen/Qwen3.7-Flash
poolside/laguna-s-2.1-free
thinkingmachines/inkling
moonshotai/Kimi-K3
gpt-5.6-luna
xai/grok-4.5
tencent/hy3-paid
zai-org/GLM-5.2-Fast
zai-org/GLM-5.2
moonshotai/Kimi-K2.7-Code-Highspeed
moonshotai/Kimi-K2.7-Code
nvidia/nemotron-3-ultra-550b-a55b
MiniMaxAI/MiniMax-M3
Qwen/Qwen3.7-Plus
stepfun/Step-3.7-Flash
Qwen/Qwen3.7-Max
stepfun/Step-3.5-Flash
zai-org/GLM-5.1
MiniMaxAI/MiniMax-M2.7
Qwen/Qwen3.6-Max-Preview
Qwen/Qwen3.6-Plus
moonshotai/Kimi-K2.6
zai-org/GLM-5
moonshotai/Kimi-K2.5
MiniMaxAI/MiniMax-M2.5`.split('\n');
  assert.deepEqual(models.map(model => model.id), ids);
  assert.equal(new Set(ids).size, 57);
  assert.equal(source.modelCount, 57);
  assert.equal(source.membership, 'https://commandcode.ai/docs/plans/go');
  assert.match(source.goPageSha256, /^[a-f0-9]{64}$/);
  assert.equal(source.cliVersion, '1.88.0');
});

test('all rows have public factual provenance, usable context and explicit four-part rates', () => {
  for (const model of models) {
    assert.ok(model.name.length > 1);
    assert.ok(Number.isSafeInteger(model.contextLength) && model.contextLength > 0);
    assert.match(model.source, /^https:\/\/commandcode\.ai\/models\/[a-z0-9-]+$/);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      assert.ok(Number.isFinite(model.usd[key]) && model.usd[key] >= 0, `${model.id}: ${key}`);
    }
    assert.ok(model.thinkingEfforts.every(effort => ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)));
    assert.ok(model.disabledReason === null || typeof model.disabledReason === 'string');
  }
  // The newest Go member is absent from CLI 1.88. Do not invent its effort set.
  assert.deepEqual(row('moonshotai/Kimi-K3.1-Pro').thinkingEfforts, []);
  assert.equal(row('moonshotai/Kimi-K3.1-Pro').effortSource, null);
  assert.equal(row('moonshotai/Kimi-K3.1-Pro').contextLength, 1_048_576);
  assert.deepEqual(row('moonshotai/Kimi-K3.1-Pro').usd, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 });
});

test('peak DeepSeek prices include cache reads and do not double flat-rate Fast', () => {
  for (const id of ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-vision-exp']) {
    assert.deepEqual(row(id).usd, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  }
  assert.deepEqual(row('deepseek/deepseek-v4-pro').usd, { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 });
  assert.deepEqual(row('deepseek/deepseek-v4.1-flash-fast').usd, { input: 0.32, output: 1.16, cacheRead: 0.032, cacheWrite: 0 });
  assert.deepEqual(row('deepseek/deepseek-v4-flash-fast').usd, { input: 0.28, output: 0.56, cacheRead: 0.07, cacheWrite: 0 });
});

test('context tiers and temporary promotions cannot understate safe quotes', () => {
  assert.deepEqual(row('gpt-6-luna').usd, { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 });
  assert.deepEqual(row('Qwen/Qwen3.7-Flash').usd, { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.25 });
  assert.deepEqual(row('Qwen/Qwen3.7-Plus').usd, { input: 1.2, output: 4.8, cacheRead: 0.24, cacheWrite: 1.5 });
  assert.deepEqual(row('Qwen/Qwen3.6-Plus').usd, { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 0 });
  assert.deepEqual(row('MiniMaxAI/MiniMax-M3').usd, { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 });
});

test('native selectable efforts are model-specific and do not falsely offer off', () => {
  assert.deepEqual(row('Qwen/Qwen3.8-Flash').thinkingEfforts, ['low', 'medium', 'xhigh']);
  assert.deepEqual(row('minimax/minimax-m3.1-flash').thinkingEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(row('deepseek/deepseek-v4-pro').thinkingEfforts, ['high', 'max']);
  assert.deepEqual(row('z-ai/glm-5.3-flash').thinkingEfforts, ['low', 'high', 'max']);
  assert.deepEqual(row('moonshotai/Kimi-K2.7-Code').thinkingEfforts, []);
  assert.ok(models.every(model => !model.thinkingEfforts.includes('off')));
});

test('cache-write and free entries stay visible but cannot enter three-price approval', () => {
  assert.equal(models.filter(model => model.usd.cacheWrite > 0).length, 7);
  assert.equal(models.filter(model => model.disabledReason).length, 10);
  const approved = getApprovedCommandCodeGoModels();
  assert.equal(approved.length, 47);
  for (const model of models) {
    assert.equal(approved.some(value => value.model === model.id), model.disabledReason === null);
    if (model.usd.cacheWrite > 0) assert.match(model.disabledReason, /缓存写入/);
    if (model.usd.input === 0 && model.usd.output === 0) assert.match(model.disabledReason, /免费模型/);
  }
});

test('CNY approval uses fixed conservative factor and only two guarded probes are verified', () => {
  assert.equal(COMMANDCODE_GO_USD_TO_CNY, 8);
  assert.deepEqual(models.filter(model => model.verified).map(model => model.id).sort(), ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash']);
  for (const approved of getApprovedCommandCodeGoModels()) {
    const model = row(approved.model);
    assert.equal(approved.endpoint, 'https://api.commandcode.ai/alpha');
    assert.deepEqual(approved.prices, {
      inputCnyPerMillion: model.usd.input * 8,
      outputCnyPerMillion: model.usd.output * 8,
      cacheHitCnyPerMillion: model.usd.cacheRead * 8,
      reasoningIncluded: true,
    });
  }
});

test('consumers cannot mutate shared catalogue or later approval results', () => {
  assert.throws(() => { models[0].usd.input = 0; }, TypeError);
  assert.throws(() => { row('z-ai/glm-5.3-flash').thinkingEfforts.push('off'); }, TypeError);
  const first = getApprovedCommandCodeGoModels();
  first[0].prices.inputCnyPerMillion = 0;
  assert.notEqual(getApprovedCommandCodeGoModels()[0].prices.inputCnyPerMillion, 0);
});
