// Size-bucket audit for the deterministic ~33% / ~67% / ~100% / all-in planner.
//
// The planner itself lives in `src/lib/decision-core.js` (`planAggressiveSizes`)
// so production, diagnostics and tests share one implementation. This module
// provides boundary descriptors and a pure audit used by the offline test.
import { planAggressiveSizes, SIZE_IDS, ACTION_FAMILY } from '../../src/lib/decision-core.js';

// Descriptors are the canonical shape consumed by `planAggressiveSizes`.
function descriptor(overrides = {}) {
  const bb = overrides.bb ?? 100;
  const highestBet = overrides.highestBet ?? 0;
  const heroCurrentBet = overrides.heroCurrentBet ?? 0;
  const heroStack = overrides.heroStack ?? 10000;
  return {
    bb,
    sb: overrides.sb ?? Math.ceil(bb / 2),
    heroStack,
    heroCurrentBet,
    highestBet,
    toCall: overrides.toCall ?? Math.max(0, highestBet - heroCurrentBet),
    pot: overrides.pot ?? bb * 1.5,
    minRaise: overrides.minRaise ?? bb,
    maxTotal: heroCurrentBet + heroStack,
    ...overrides,
  };
}

export const SIZE_AUDIT_CASES = Object.freeze([
  { id: 'tiny-stack', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 40, pot: 300, bb: 100 }) },
  { id: 'very-large-stack', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 5_000_000, pot: 300, bb: 100 }) },
  { id: 'min-bet-boundary', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 100, pot: 60, bb: 100 }) },
  { id: 'min-raise-boundary', family: ACTION_FAMILY.RAISE, descriptor: descriptor({ heroStack: 10000, highestBet: 100, heroCurrentBet: 0, minRaise: 100, pot: 250 }) },
  { id: 'allin-below-min-raise', family: ACTION_FAMILY.RAISE, descriptor: descriptor({ heroStack: 150, highestBet: 100, heroCurrentBet: 100, minRaise: 200, pot: 400 }) },
  { id: 'allin-near-large', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 3000, pot: 1000, bb: 100 }) },
  { id: 'pot-smaller-than-bb', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 10000, pot: 50, bb: 100 }) },
  { id: 'heads-up-short', family: ACTION_FAMILY.RAISE, descriptor: descriptor({ heroStack: 600, highestBet: 200, heroCurrentBet: 100, minRaise: 200, pot: 350 }) },
  { id: 'multiway-large-pot', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 8000, pot: 9000, bb: 100 }) },
  { id: 'post-elimination-short', family: ACTION_FAMILY.BET, descriptor: descriptor({ heroStack: 800, pot: 1200, bb: 200 }) },
]);

const NEAR_FRACTION = 0.15;

// Pure audit. Returns the list of violated invariants (empty = healthy).
export function auditSizes(sizes, d) {
  const issues = [];
  const amounts = (sizes ?? []).map(size => Number(size.amount));
  if (sizes.length > 4) issues.push('more_than_four_buckets');
  if (new Set(amounts).size !== amounts.length) issues.push('duplicate_amount');
  const maxTotal = Math.floor(Number(d?.maxTotal) || 0);
  const near = Math.max(2, Math.round(Math.min(Math.max(1, Number(d?.bb) || 1), Math.max(1, Number(d?.pot) || 1)) * NEAR_FRACTION));
  for (let i = 0; i < amounts.length; i++) {
    const amount = amounts[i];
    if (!Number.isFinite(amount) || amount <= 0) issues.push('invalid_amount');
    if (amount > maxTotal) issues.push('amount_over_stack');
    for (let j = i + 1; j < amounts.length; j++) {
      if (Math.abs(amounts[j] - amount) <= near) { issues.push('meaningless_near_duplicate'); break; }
    }
  }
  const ids = (sizes ?? []).map(size => size.id);
  if (new Set(ids).size !== ids.length) issues.push('duplicate_size_id');
  for (const id of ids) if (!SIZE_IDS.includes(id)) issues.push(`unknown_size_id:${id}`);
  return [...new Set(issues)];
}

export function planForCase(testCase, { validate = null } = {}) {
  const sizes = planAggressiveSizes({ family: testCase.family, descriptor: testCase.descriptor, validate });
  return { sizes, issues: auditSizes(sizes, testCase.descriptor) };
}
