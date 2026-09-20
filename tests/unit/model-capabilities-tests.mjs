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
  resolveTemperature, DEFAULT_TEMPERATURE,
} from '../../src/lib/decision-core.js';

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

console.log('model-capabilities-test: capability-aware temperature PASS');
