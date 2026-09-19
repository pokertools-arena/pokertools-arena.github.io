// Standardized benchmark counters.
//
// Terminology used to drift: "decisions", "model calls" and "HTTP requests"
// were sometimes reported as if interchangeable. They are not.
//
//   * pokerDecisions      one row = one acting seat asked to make one poker move
//   * familyModelCalls    stage-1 family requests (flat menus and hierarchical)
//   * sizingModelCalls    stage-2 sizing requests (hierarchical BET/RAISE only)
//   * spectatorModelCalls isolated off-clock explanation requests
//   * totalModelCalls     familyModelCalls + sizingModelCalls + spectatorModelCalls
//   * httpRequests        every HTTP request sent, including retries
//   * httpRetries         retries beyond the first attempt
//   * rateLimitResponses  429 responses observed
//   * decisionErrors      poker decisions that ended in an error
//   * fallbackActions     poker decisions that used the automatic fallback
//   * protocolFallbacks   tool→json_schema capability fallbacks observed
//
// A hierarchical aggressive poker decision is therefore 1 poker decision,
// 2 family/sizing model calls, and 2+ HTTP requests if retries occur.

export const COUNTER_NAMES = Object.freeze([
  'pokerDecisions', 'familyModelCalls', 'sizingModelCalls', 'spectatorModelCalls',
  'totalModelCalls', 'httpRequests', 'httpRetries', 'rateLimitResponses',
  'decisionErrors', 'fallbackActions', 'protocolFallbacks',
]);

export function createCounters(initial = {}) {
  const counters = Object.fromEntries(COUNTER_NAMES.map(name => [name, 0]));
  for (const name of COUNTER_NAMES) if (Number.isFinite(Number(initial[name]))) counters[name] = Number(initial[name]);
  return counters;
}

export function addCounters(target, delta = {}) {
  for (const name of COUNTER_NAMES) target[name] += Number(delta[name]) || 0;
  return target;
}

// Counters from a single diagnostic result row. `architecture` is 'flat' or
// 'hierarchical'; a hierarchical row is two model calls when a size was asked.
export function countersForResult(row, { architecture = row?.architecture ?? 'flat' } = {}) {
  const counters = createCounters();
  counters.pokerDecisions = 1;
  const isHierarchical = architecture === 'hierarchical';
  const hasSizing = isHierarchical && (row?.sizeChoice != null || row?.sizeId != null);
  counters.familyModelCalls = 1;
  counters.sizingModelCalls = hasSizing ? 1 : 0;
  counters.totalModelCalls = counters.familyModelCalls + counters.sizingModelCalls;
  counters.httpRequests = counters.totalModelCalls + (Number(row?.meta?.retryCount) || 0);
  counters.httpRetries = Number(row?.meta?.retryCount) || 0;
  counters.rateLimitResponses = (row?.meta?.incidents ?? []).filter(i => i?.category === 'rate_limit').length;
  counters.decisionErrors = row?.error ? 1 : 0;
  counters.protocolFallbacks = row?.meta?.protocolFallbackTriggered ? 1 : 0;
  return counters;
}

export function countersFromResults(results, options = {}) {
  const total = createCounters();
  for (const row of results ?? []) addCounters(total, countersForResult(row, options));
  return total;
}

// Hard relationships the reporting layer relies on. Throws with a precise
// message rather than silently emitting a contradictory report.
export function validateCounters(counters) {
  const c = counters ?? {};
  const num = name => Number(c[name]) || 0;
  const expected = num('familyModelCalls') + num('sizingModelCalls') + num('spectatorModelCalls');
  if (num('totalModelCalls') !== expected) {
    throw new Error(`Counter mismatch: totalModelCalls=${num('totalModelCalls')} but family+sizing+spectator=${expected}`);
  }
  if (num('httpRequests') < num('totalModelCalls')) {
    throw new Error(`Counter mismatch: httpRequests=${num('httpRequests')} < totalModelCalls=${num('totalModelCalls')}`);
  }
  if (num('httpRetries') > num('httpRequests')) {
    throw new Error(`Counter mismatch: httpRetries=${num('httpRetries')} > httpRequests=${num('httpRequests')}`);
  }
  if (num('totalModelCalls') < num('pokerDecisions')) {
    throw new Error(`Counter mismatch: totalModelCalls=${num('totalModelCalls')} < pokerDecisions=${num('pokerDecisions')}`);
  }
  if (num('decisionErrors') > num('pokerDecisions')) {
    throw new Error(`Counter mismatch: decisionErrors=${num('decisionErrors')} > pokerDecisions=${num('pokerDecisions')}`);
  }
  if (num('fallbackActions') > num('pokerDecisions')) {
    throw new Error(`Counter mismatch: fallbackActions=${num('fallbackActions')} > pokerDecisions=${num('pokerDecisions')}`);
  }
  return true;
}
