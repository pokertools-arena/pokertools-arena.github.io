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
  resolveTemperature, isReasoningModel, DEFAULT_TEMPERATURE, makeHeaders, wantsReasoning,
  reasoningEffortsFor, defaultReasoningEffort, resolveReasoningEffort, reasoningOverrideFor, truncationReasoningOverride,
  isUnsupportedToolChoiceError, ArenaRequestError, requiresReasoning,
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
assert.deepEqual(glmBody.reasoning, { max_tokens: 256, exclude: false }, 'reasoning must be capped and returned for display');
const deepseekBody = bodyFor('deepseek/deepseek-v4.1-flash', 0.3, 'tool');
assert.equal(deepseekBody.max_tokens, 2048, 'deepseek v4 gets the reasoning completion budget');

// 7. OpenRouter attribution is visible in Settings and explicit values are never overwritten.
const attribution = JSON.parse(defaultExtraHeaders('openrouter'));
assert.equal(attribution['HTTP-Referer'], 'https://pokertools-arena.github.io/');
assert.equal(attribution['X-OpenRouter-Title'], 'pokertools-arena');
const customHeaders = makeHeaders({ ...connection, headers: JSON.stringify({ 'HTTP-Referer': 'https://example.test/', 'X-OpenRouter-Title': 'Example' }) });
assert.equal(customHeaders['HTTP-Referer'], 'https://example.test/');
assert.equal(customHeaders['X-OpenRouter-Title'], 'Example');

// 8. OpenRouter's per-model `reasoning` metadata gates the seat's effort
//    choice. An unsupported effort must fall back to the historical cap rather
//    than being sent and hard-failing routing under `require_parameters`.
registerModelCapabilities([
  { id: 'deepseek/deepseek-v4.1-flash', supported_parameters: ['reasoning', 'reasoning_effort', 'tools', 'max_tokens'], reasoning: { mandatory: false, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' } },
  { id: 'deepseek/deepseek-v4-pro', supported_parameters: ['reasoning', 'tools'], reasoning: { mandatory: false, supported_efforts: ['xhigh', 'high'], default_effort: 'high' } },
  { id: 'vendor/no-efforts', supported_parameters: ['reasoning', 'tools'], reasoning: { mandatory: false } },
]);
assert.deepEqual(reasoningEffortsFor('deepseek/deepseek-v4.1-flash'), ['max', 'high', 'low']);
assert.equal(defaultReasoningEffort('deepseek/deepseek-v4.1-flash'), 'high');
assert.equal(resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'low'), 'low');
assert.equal(resolveReasoningEffort('deepseek/deepseek-v4.1-flash', 'medium'), null, 'unsupported effort must be rejected');
assert.equal(resolveReasoningEffort('unknown/model', 'low'), 'low', 'unknown models must trust the explicit choice');
assert.deepEqual(reasoningEffortsFor('vendor/no-efforts'), [], 'models without supported_efforts expose none');
assert.equal(resolveReasoningEffort('vendor/no-efforts', 'low'), null, 'a catalogued model without efforts must reject an effort instead of sending it');
assert.deepEqual(reasoningOverrideFor({ model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'low' }), { effort: 'low' });
assert.deepEqual(reasoningOverrideFor({ model: 'deepseek/deepseek-v4.1-flash' }), { max_tokens: 256, exclude: false }, 'an unset effort keeps the cap');
assert.deepEqual(reasoningOverrideFor({ model: 'deepseek/deepseek-v4.1-flash', reasoningEffort: 'medium' }), { max_tokens: 256, exclude: false }, 'an unsupported effort keeps the cap');
assert.deepEqual(truncationReasoningOverride('deepseek/deepseek-v4.1-flash'), { effort: 'low' });
assert.deepEqual(truncationReasoningOverride('deepseek/deepseek-v4-pro'), { max_tokens: 4096, exclude: false }, 'retry must not send an effort the model rejects');
const effortBody = buildOpenAICompatibleBody({
  agent: { model: 'deepseek/deepseek-v4.1-flash', temperature: 0.3, protocol: 'tool', provider: '', reasoningEffort: 'low' },
  connection, state: {}, legalActions, decisionId: 'effort-test', protocol: 'tool', instructions: 'Choose exactly one.', criteria, representationText: '{}',
});
assert.deepEqual(effortBody.reasoning, { effort: 'low' }, 'the seat effort must reach the request');
const electedBody = buildOpenAICompatibleBody({
  agent: { model: 'openai/gpt-5.6-luna', temperature: 0.3, protocol: 'tool', provider: '', reasoningEffort: 'low' },
  connection, state: {}, legalActions, decisionId: 'elected-test', protocol: 'tool', instructions: 'Choose exactly one.', criteria, representationText: '{}',
});
assert.equal(electedBody.max_tokens, 2048, 'an elected effort raises the completion budget');
assert.deepEqual(electedBody.reasoning, { effort: 'low' }, 'an elected effort is sent for a model the name heuristic misses');
assert.equal(wantsReasoning({ model: 'openai/gpt-5.6-luna', reasoningEffort: 'low' }), true, 'an explicit effort opts the seat into reasoning even without a reasoning-model name');
assert.equal(wantsReasoning({ model: 'openai/gpt-5.6-luna' }), false, 'without an effort the historical detection is unchanged');

// 9. Mandatory reasoning must imply the reasoning budget even when the model
//    name misses the heuristic (muse-spark always reasons), otherwise a 320-token
//    completion budget starves it.
registerModelCapabilities([{ id: 'meta/muse-spark-1.3-contributor', supported_parameters: ['reasoning', 'reasoning_effort', 'tools'], reasoning: { mandatory: true, supported_efforts: ['max', 'high', 'medium', 'low', 'minimal'], default_effort: 'medium' } }]);
assert.equal(isReasoningModel('meta/muse-spark-1.3-contributor'), false, 'name heuristic cannot see muse-spark');
assert.equal(wantsReasoning({ model: 'meta/muse-spark-1.3-contributor' }), true, 'mandatory reasoning models need no opt-in');
assert.equal(requiresReasoning('meta/muse-spark-1.3-contributor'), true, 'mandatory reasoning must be flagged for the seat warning');
assert.equal(requiresReasoning('deepseek/deepseek-v4.1-flash'), false, 'optional reasoning must not be flagged as mandatory');
const museBody = buildOpenAICompatibleBody({
  agent: { model: 'meta/muse-spark-1.3-contributor', temperature: 0.3, protocol: 'tool', provider: '' },
  connection, state: {}, legalActions, decisionId: 'muse-test', protocol: 'tool', instructions: 'Choose exactly one.', criteria, representationText: '{}',
});
assert.equal(museBody.max_tokens, 2048, 'mandatory reasoning gets the larger completion budget');
assert.deepEqual(museBody.reasoning, { max_tokens: 256, exclude: false }, 'mandatory reasoning keeps the capped default until an effort is chosen');

// 10. OpenRouter hides the provider's real reason behind a generic top-level
//     message. The tool_choice fallback must still see it, or a provider that
//     only accepts `auto` is rejected and the seat auto-folds every hand.
const nestedToolChoiceError = new ArenaRequestError('Provider returned error', {
  status: 400, category: 'provider',
  payload: { error: { message: 'Provider returned error', metadata: { raw: JSON.stringify({ error: { message: 'only "auto" is supported for tool_choice', param: 'tool_choice', type: 'invalid_request_error' } }) } } },
});
assert.equal(isUnsupportedToolChoiceError(nestedToolChoiceError), true, 'nested provider tool_choice errors must trigger the JSON-schema fallback');
assert.equal(isUnsupportedToolChoiceError(new ArenaRequestError('Provider returned error', { status: 400, payload: { error: { message: 'Provider returned error' } } })), false, 'an unrelated provider error must not trigger the fallback');

console.log('model-capabilities-test: capability-aware temperature PASS');
