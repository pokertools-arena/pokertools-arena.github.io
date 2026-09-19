import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';

const engine = createBrowserEngine({
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxPlayers: 2,
  validateIntegrity: true,
});

engine.sit(0, 'alice', 'Alice', 1000);
engine.sit(1, 'bob', 'Bob', 1000);
engine.deal();

assert.equal(engine.state.players.filter(Boolean).length, 2);
assert.equal(engine.state.board.length, 0);
assert.ok(Number.isInteger(engine.state.actionTo));

const actingSeat = engine.state.actionTo;
const acting = engine.state.players[actingSeat];
assert.ok(acting?.id);
assert.equal(Array.isArray(acting.hand), true);
assert.equal(acting.hand.length, 2);

const masked = engine.view(acting.id);
for (const player of masked.players.filter(Boolean)) {
  if (player.id === acting.id) {
    assert.equal(player.hand.length, 2);
    assert.ok(player.hand.every(Boolean));
  } else {
    assert.ok(player.hand == null || player.hand.every(card => card == null));
  }
}

const fold = { type: 'FOLD', playerId: acting.id };
const validation = engine.validate(fold);
assert.equal(validation.valid, true, validation.error || 'FOLD should be legal for actionTo');
engine.act(fold);
assert.ok(engine.state.winners?.length >= 1, 'Heads-up fold should settle the hand');

const total = engine.state.players.filter(Boolean).reduce((sum, p) => sum + p.stack, 0)
  + [...engine.state.currentBets.values()].reduce((a, b) => a + b, 0)
  + engine.state.pots.reduce((sum, p) => sum + (p.amount || 0), 0);
assert.equal(total, 2000, 'PokerTools must conserve tournament chips');

console.log('pokertools-integration: PASS');
