import assert from 'node:assert/strict';
import { createBrowserEngine } from '@pokertools/engine/browser';
import { positionForSeat, potChipBreakdown, tableMarkerSeats } from '../../src/lib/decision-core.js';

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

const tournament = createBrowserEngine({
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxPlayers: 4,
  blindStructure: [{ smallBlind: 5, bigBlind: 10, ante: 0 }],
  validateIntegrity: true,
});
for (let seat = 0; seat < 4; seat++) tournament.sit(seat, `p${seat}`, `Player ${seat + 1}`, 100);
const settleByFolding = () => {
  while (!tournament.state.winners) {
    const player = tournament.state.players[tournament.state.actionTo];
    tournament.act({ type: 'FOLD', playerId: player.id });
  }
};

tournament.deal();
assert.deepEqual(tableMarkerSeats(tournament.state), { buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2, headsUp: false });
assert.deepEqual(tournament.state.players.map((p, seat) => p && positionForSeat(tournament.state, seat)), ['BTN', 'SB', 'BB', 'UTG']);
settleByFolding();
tournament.stand('p1');
tournament.deal();
assert.deepEqual(tableMarkerSeats(tournament.state), { buttonSeat: 1, smallBlindSeat: 2, bigBlindSeat: 3, headsUp: false }, 'Three-handed display must preserve the engine dead-button rule');
assert.equal(positionForSeat(tournament.state, 2), 'SB');
assert.equal(positionForSeat(tournament.state, 3), 'BB');
settleByFolding();
tournament.stand('p2');
tournament.deal();
assert.deepEqual(tableMarkerSeats(tournament.state), { buttonSeat: 3, smallBlindSeat: 3, bigBlindSeat: 0, headsUp: true }, 'Heads-up button must also be the small blind');
assert.equal(positionForSeat(tournament.state, 3), 'BTN/SB');
assert.equal(positionForSeat(tournament.state, 0), 'BB');

const oddPot = potChipBreakdown(103, { smallBlind: 5, bigBlind: 10, ante: 0 });
assert.equal(oddPot.reduce((sum, chip) => sum + chip.value * chip.count, 0), 103, 'Visual chips must represent the exact engine pot');
assert.equal(oddPot.at(-1).value, 1, 'Odd all-in remainders need a unit chip');

console.log('pokertools-integration: PASS');
