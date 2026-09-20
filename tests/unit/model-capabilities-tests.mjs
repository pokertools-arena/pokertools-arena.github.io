// Offline regression tests for capability-aware sampling parameters.
//
// OpenRouter requests are routed with `require_parameters: true`, so an
// optional parameter that a model's endpoints do not support (GPT-5-class models
// dropped `temperature`) makes routing fail outright. These tests prove that
// optional sampling parameters are omitted only when the catalogue says so,
// while structural parameters remain enforced.
import assert from 'node:assert/strict';
import {
  buildOpenAICompatibleBody, registerModelCapabilities, modelSupportsParameter,
  resolveTemperature, isReasoningModel, DEFAULT_TEMPERATURE, makeHeaders,
} from '../../src/lib/decision-core.js';
import { defaultExtraHeaders } from '../../src/config/arena-config.js';

const connection = { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test-key', kind: 'openrouter', headers: '' };
const legalActions = [
  { id: 'A0', type: 'FOLD', amount: null, description: 'Fold' },
  { id: 'A1', type: 'CHECK', amount: null, description: 'Check' },
];
const criteria = { A0: 'Fold', A1: 'Check' };
function bodyFor(model, temperature = DEFAULT_TEMPERATURE, protocol = 'tool') {
  return buildOpenAICompatibleBody({
    agent: { model, temperature, protocol, provider: '' }, connection, state: {}, legalActions,
    decisionId: 'cap-test', protocol, instructions: 'Choose exactly one.', criteria, representationText: '{}',
  });
}

// 1. Unknown models keep the historical default: always send temperature.
assert.equal(modelSupportsParameter('unknown/model', 'temperature'), null);
assert.equal(resolveTemperature('unknown/model', undefined), DEFAULT_TEMPERATURE);
assert.equal(bodyFor('unknown/model').temperature, DEFAULT_TEMPERATURE, 'unknown model keeps default temperature');

// 2. Models that advertise temperature keep the requested value.
registerModelCapabilities([{ id: 'vendor/sampling-model', supported_parameters: ['temperature', 'tools', 'response_format', 'max_tokens'] }]);
assert.equal(modelSupportsParameter('vendor/sampling-model', 'temperature'), true);
assert.equal(bodyFor('vendor/sampling-model', 0.7).temperature, 0.7);

// 3. Models without temperature support omit it, but the structural contract stays.
registerModelCapabilities([{ id: 'openai/gpt-5.6-luna', supported_parameters: ['tools', 'response_format', 'max_tokens', 'reasoning'] }]);
assert.equal(modelSupportsParameter('openai/gpt-5.6-luna', 'temperature'), false);
assert.equal(resolveTemperature('openai/gpt-5.6-luna', 0.3), undefined);
const toolBody = bodyFor('openai/gpt-5.6-luna', 0.3, 'tool');
assert.ok(!('temperature' in toolBody), 'temperature must be omitted when unsupported');
assert.equal(toolBody.max_tokens, 320, 'max_tokens is still sent');
assert.deepEqual(toolBody.provider, { allow_fallbacks: true, require_parameters: true }, 'structural parameters must still be required');
assert.equal(toolBody.tool_choice.function.name, 'play_poker_action');

// 4. The JSON Schema path drops temperature too and keeps response_format.
const schemaBody = bodyFor('openai/gpt-5.6-luna', 0.3, 'json_schema');
assert.ok(!('temperature' in schemaBody));
assert.equal(schemaBody.response_format.type, 'json_schema');

// 5. Partial or malformed catalogue entries are ignored, never fatal.
registerModelCapabilities([null, 'string-model', { id: 'no-params' }, { id: 'bad-params', supported_parameters: 'temperature' }]);
for (const id of ['string-model', 'no-params', 'bad-params']) {
  assert.equal(modelSupportsParameter(id, 'temperature'), null, `${id} must stay unknown`);
}

// 6. Reasoning detection covers every current GLM version and its vision/turbo
// variants; a missed detection leaves the completion budget too small for the
// hidden reasoning, which returns an empty tool call and forces a fallback.
for (const id of ['z-ai/glm-4.5', 'z-ai/glm-4.6', 'z-ai/glm-4.7-flash', 'z-ai/glm-5', 'z-ai/glm-5.3-flash', 'z-ai/glm-5v-turbo', 'z-ai/glm-latest', 'deepseek/deepseek-r1', 'deepseek/deepseek-v3.1', 'deepseek/deepseek-v4.1-flash']) {
  assert.equal(isReasoningModel(id), true, `${id} must be treated as a reasoning model`);
}
assert.equal(isReasoningModel('google/gemma-4-26b-a4b-it'), false, 'gemma is not a reasoning model');
const glmBody = bodyFor('z-ai/glm-5.3-flash', 0.3, 'tool');
assert.equal(glmBody.max_tokens, 2048, 'reasoning models get the larger completion budget');
assert.deepEqual(glmBody.reasoning, { max_tokens: 256, exclude: true }, 'reasoning must be capped and excluded');
const deepseekBody = bodyFor('deepseek/deepseek-v4.1-flash', 0.3, 'tool');
assert.equal(deepseekBody.max_tokens, 2048, 'deepseek v4 gets the reasoning completion budget');

// 7. OpenRouter attribution is visible in Settings and explicit values are never overwritten.
const attribution = JSON.parse(defaultExtraHeaders('openrouter'));
assert.equal(attribution['HTTP-Referer'], 'https://pokertools-arena.github.io/');
assert.equal(attribution['X-OpenRouter-Title'], 'pokertools-arena');
const customHeaders = makeHeaders({ ...connection, headers: JSON.stringify({ 'HTTP-Referer': 'https://example.test/', 'X-OpenRouter-Title': 'Example' }) });
assert.equal(customHeaders['HTTP-Referer'], 'https://example.test/');
assert.equal(customHeaders['X-OpenRouter-Title'], 'Example');

console.log('model-capabilities-test: capability-aware temperature PASS');
