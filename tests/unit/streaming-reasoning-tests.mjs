#!/usr/bin/env node
// Offline contract tests for the streaming reasoning transport.
//
//   node tests/unit/streaming-reasoning-tests.mjs
//
// Verifies the SSE reassembly, the delta callback contract, the non-SSE
// fallback, the streamed request body, and end-to-end reasoning capture through
// decideHierarchical — all against a stubbed fetch, so no network is used.
import assert from 'node:assert/strict';
import {
  buildOpenAICompatibleBody, fetchStreamingJson, decideHierarchical, isReasoningModel, wantsReasoning,
} from '../../src/lib/decision-core.js';
import { diagnosticState } from '../../tools/diagnostics/scenarios.js';

const encoder = new TextEncoder();
function sseResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(typeof chunk === 'string' ? chunk : `data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' }, body: stream, json: async () => { throw new Error('should not parse json'); } };
}
const text = value => ({ choices: [{ index: 0, delta: value, finish_reason: null }] });

// 1. SSE reassembly: reasoning, content, split tool-call arguments, usage, model.
{
  const original = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { model: 'stub/model', provider: 'Stub', choices: [{ index: 0, delta: { role: 'assistant', reasoning: 'We must ' }, finish_reason: null }] },
    { model: 'stub/model', choices: [{ index: 0, delta: { reasoning: 'choose a family.' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'choose_action_' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'family', arguments: '{"decisionId":"d1",' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"actionFamily":"raise"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 12 } } },
  ]);
  try {
    const deltas = [];
    const result = await fetchStreamingJson('https://example.test/chat/completions', {}, { onDelta: d => deltas.push(d) });
    assert.equal(result.reasoning, 'We must choose a family.', 'reasoning must be reassembled');
    assert.equal(result.payload.model, 'stub/model');
    assert.equal(result.payload.provider, 'Stub');
    assert.equal(result.payload.usage.completion_tokens_details.reasoning_tokens, 12, 'streamed usage must survive');
    assert.equal(result.payload.choices[0].finish_reason, 'tool_calls');
    const call = result.payload.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, 'choose_action_family', 'split tool-call name must reassemble');
    assert.deepEqual(JSON.parse(call.function.arguments), { decisionId: 'd1', actionFamily: 'raise' }, 'split arguments must reassemble');
    assert.ok(deltas.some(d => d.channel === 'reasoning' && d.text === 'We must choose a family.'), 'accumulated reasoning deltas required');
    assert.ok(deltas.every(d => d.channel === 'reasoning'), 'no content channel when only reasoning streams');
  } finally { globalThis.fetch = original; }
}

// 2. A non-SSE response (server ignored stream:true) must fall back to JSON.
{
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, body: null, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) });
  try {
    const result = await fetchStreamingJson('https://example.test/chat/completions', {}, { onDelta: () => {} });
    assert.equal(result.reasoning, '');
    assert.equal(result.payload.choices[0].message.content, 'ok');
  } finally { globalThis.fetch = original; }
}

// 3. Streamed body: reasoning is returned (not excluded) and usage is requested.
{
  const body = buildOpenAICompatibleBody({
    agent: { model: 'z-ai/glm-5.3-flash', temperature: 0.3 },
    connection: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
    state: { hero: {}, betting: {} }, legalActions: [{ id: 'A0', type: 'FOLD' }], decisionId: 'd1', stream: true,
  });
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true }, 'streamed usage must be requested');
  assert.deepEqual(body.reasoning, { max_tokens: 256, exclude: false }, 'reasoning must be returned for display');
}

// 4. End-to-end: decideHierarchical captures per-stage reasoning from the stream.
{
  const legalActions = [
    { id: 'A0', type: 'FOLD', amount: null, description: 'Fold' },
    { id: 'A1', type: 'CALL', amount: null, description: 'Call 50' },
    { id: 'A2', type: 'RAISE', amount: 100, description: 'Raise to 100' },
    { id: 'A3', type: 'RAISE', amount: 200, description: 'Raise to 200' },
    { id: 'A4', type: 'RAISE', amount: 400, description: 'Raise to 400' },
  ];
  const state = diagnosticState({
    blinds: { smallBlind: 25, bigBlind: 50, ante: 5 }, pot: 105, street: 'PREFLOP',
    hero: { id: 'h', name: 'Hero', seat: 1, position: 'UTG', stack: 2995, stackBB: 59.9, cards: ['6h', '5c'], currentBet: 0 },
    betting: { highestBet: 50, heroCurrentBet: 0, toCall: 50, effectiveCall: 50, stackBehind: 2995, facingAllInCall: false },
    legalActions,
  });
  const sizes = [
    { id: 'small', label: 'SMALL', amount: 100 },
    { id: 'medium', label: 'MEDIUM', amount: 200 },
    { id: 'large', label: 'LARGE', amount: 400 },
  ];
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, true, 'production streamed path must set stream:true');
    assert.deepEqual(body.stream_options, { include_usage: true });
    const toolName = body.tools[0].function.name;
    seen.push(toolName);
    if (toolName === 'choose_action_family') {
      return sseResponse([
        text({ reasoning: 'Facing a raise with 65o. ' }),
        text({ reasoning: 'Raise as a semi-bluff.' }),
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'choose_action_family', arguments: '{"decisionId":"d1","actionFamily":"raise"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 900, completion_tokens: 120 } },
      ]);
    }
    return sseResponse([
      text({ reasoning: 'Medium keeps the bluff cheap.' }),
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'choose_bet_size', arguments: '{"decisionId":"d1","sizeId":"medium"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 400, completion_tokens: 60 } },
    ]);
  };
  try {
    const stageDeltas = [];
    const result = await decideHierarchical({
      agent: { id: 'p', name: 'P', model: 'deepseek/deepseek-v4.1-flash', protocol: 'tool', provider: '', temperature: 0.3 },
      connection: { id: 'c', name: 'OpenRouter', kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'test', headers: '' },
      state, legalActions, decisionId: 'd1', timeoutMs: 30_000, representationMode: 'canonical_json',
      sizesForFamily: () => sizes,
      onDelta: info => stageDeltas.push(info),
    });
    assert.deepEqual(seen, ['choose_action_family', 'choose_bet_size'], 'both hierarchical stages must stream');
    assert.equal(result.action.type, 'RAISE');
    assert.equal(result.action.amount, 200);
    assert.equal(result.reasoning.family, 'Facing a raise with 65o. Raise as a semi-bluff.', 'family reasoning must be captured');
    assert.equal(result.reasoning.sizing, 'Medium keeps the bluff cheap.', 'sizing reasoning must be captured');
    assert.ok(stageDeltas.some(d => d.stage === 'family' && d.channel === 'reasoning'), 'family stage deltas must be tagged');
    assert.ok(stageDeltas.some(d => d.stage === 'size' && d.channel === 'reasoning'), 'size stage deltas must be tagged');
    assert.equal(isReasoningModel('deepseek/deepseek-v4.1-flash'), true);
  } finally { globalThis.fetch = original; }
}

// 5. Per-seat opt-in: a model that is not a reasoning model by name gets the
//    reasoning directive (and the larger completion budget) only when its seat
//    explicitly opts in.
{
  const base = { connection: { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }, state: { hero: {}, betting: {} }, legalActions: [{ id: 'A0', type: 'FOLD' }], decisionId: 'd1' };
  const off = buildOpenAICompatibleBody({ ...base, agent: { model: 'google/gemma-4-26b-a4b-it', temperature: 0.3 } });
  assert.equal(off.reasoning, undefined, 'gemma must not request reasoning by default');
  assert.equal(off.max_tokens, 320, 'non-reasoning default budget');
  const on = buildOpenAICompatibleBody({ ...base, agent: { model: 'google/gemma-4-26b-a4b-it', temperature: 0.3, captureReasoning: true } });
  assert.deepEqual(on.reasoning, { max_tokens: 256, exclude: false }, 'opt-in must request reasoning');
  assert.equal(on.max_tokens, 2048, 'opt-in must raise the completion budget');
  assert.equal(wantsReasoning({ model: 'google/gemma-4-26b-a4b-it' }), false, 'gemma stays opt-in by default');
  assert.equal(wantsReasoning({ model: 'google/gemma-4-26b-a4b-it', captureReasoning: true }), true, 'opt-in must be honoured');
  assert.equal(wantsReasoning({ model: 'deepseek/deepseek-v4.1-flash' }), true, 'named reasoning models need no opt-in');
}

console.log('streaming-reasoning: all assertions passed');
