const POLICY = Object.freeze({
  private: 'hero hole cards only',
  public: 'board, pot, blinds, stacks, positions, current-hand actions, recent public hand history, public player statistics, and legal actions',
  excluded: 'opponent hole cards, other agents reasoning, model outputs, API/provider metadata, hidden deck state, and future cards',
});

const OBJECTIVE = 'Choose exactly one legal action that best maximizes tournament chip EV from the supplied state. Use only the information in this state and only an actionId present in legalActions.';

function action(id, type, description, amount = null) { return { id, type, amount, description }; }
// Production serializeForAgent always includes this derived object. The legacy
// fixtures omitted it, which is a real state-serialization confound: models that
// rely on betting.toCall can misread an otherwise free check. Derive it from the
// merged hero/opponent state so every sanity scenario is production-shaped.
function withBetting(state) {
  const heroBet = Number(state.hero?.currentBet) || 0;
  const highestBet = Math.max(heroBet, ...(state.opponents ?? []).map(o => Number(o.currentBet) || 0));
  const toCall = Math.max(0, highestBet - heroBet);
  const stack = Number(state.hero?.stack) || 0;
  return {
    ...state,
    betting: {
      highestBet,
      heroCurrentBet: heroBet,
      toCall,
      effectiveCall: Math.min(stack, toCall),
      stackBehind: stack,
      facingAllInCall: stack > 0 && stack <= toCall,
    },
  };
}
function baseState(overrides = {}) {
  return withBetting({
    contextVersion: 3,
    informationPolicy: POLICY,
    objective: OBJECTIVE,
    game: 'No-Limit Texas Holdem tournament',
    memoryPolicy: {
      currentHand: 'all public model actions in the current hand before this decision',
      recentHands: 'last 8 completed public hands',
      publicPlayerStats: 'deterministic aggregates from completed hands before the current hand; identical public dataset for every seat',
    },
    tournament: { handNumber: 50, blindLevel: 4, playersRemaining: 2, startingPlayers: 2 },
    blinds: { smallBlind: 50, bigBlind: 100, ante: 0 },
    hero: { id: 'benchmark-hero', name: 'Benchmark Hero', seat: 1, position: 'BTN/SB', stack: 10000, stackBB: 100, cards: ['As', 'Kd'], currentBet: 0 },
    board: [], street: 'PREFLOP', pot: 150, buttonSeat: 1,
    actionHistory: [], recentHands: [],
    publicPlayerStats: [
      { playerId: 'benchmark-hero', playerName: 'Benchmark Hero', sampleHands: 40, vpipPct: 0.30, pfrPct: 0.22, aggressionPct: 0.41, foldPct: 0.28, callPct: 0.24, checkPct: 0.18, wins: 10 },
      { playerId: 'benchmark-villain', playerName: 'Benchmark Villain', sampleHands: 40, vpipPct: 0.31, pfrPct: 0.21, aggressionPct: 0.40, foldPct: 0.29, callPct: 0.24, checkPct: 0.17, wins: 9 },
    ],
    opponents: [{ seat: 2, id: 'benchmark-villain', name: 'Benchmark Villain', stack: 10000, stackBB: 100, currentBet: 100, status: 'ACTIVE', cards: [] }],
    legalActions: [],
    ...overrides,
  });
}

export const DECISION_SANITY_SCENARIOS = Object.freeze([
  {
    id: 'free-check-dominates-fold', title: 'Free check dominates folding', category: 'Dominance',
    expectedTypes: ['CHECK'], note: 'With no bet to call, checking preserves every future outcome while folding gives up immediately.',
    state: baseState({ street: 'FLOP', hero: { id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:5000,stackBB:50,cards:['7c','2d'],currentBet:0 }, board:['As','Kd','Qh'], pot:300, opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:5000,stackBB:50,currentBet:0,status:'ACTIVE',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CHECK','Check')] }),
  },
  {
    id: 'board-royal-call', title: 'Board royal flush: call a small bet', category: 'Guaranteed tie',
    expectedTypes: ['CALL'], note: 'The board itself is a royal flush, so folding gives up a guaranteed share of the pot.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:4900,stackBB:49,cards:['2c','3d'],currentBet:0}, board:['As','Ks','Qs','Js','Ts'], pot:1100, actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:100,description:'Bet 100 (1 BB)'},potBefore:1000}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:4900,stackBB:49,currentBet:100,status:'ACTIVE',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 100')] }),
  },
  {
    id: 'royal-nuts-call', title: 'Royal flush facing a shove', category: 'Nuts',
    expectedTypes: ['CALL'], note: 'Hero holds the unbeatable royal flush and must not fold to an all-in bet.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:4000,stackBB:40,cards:['As','Ks'],currentBet:0}, board:['Qs','Js','Ts','2d','3c'], pot:6000, actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:4000,description:'All-in 4000 (40 BB)'},potBefore:2000}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:0,stackBB:0,currentBet:4000,status:'ALL_IN',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 4000')] }),
  },
  {
    id: 'straight-flush-call', title: 'Straight flush facing a river bet', category: 'Nuts',
    expectedTypes: ['CALL'], note: 'Hero has a nine-high straight flush; folding to the available call is an obvious sanity failure.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:7000,stackBB:70,cards:['9s','8s'],currentBet:0}, board:['7s','6s','5s','Kd','2c'], pot:3500, opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:5500,stackBB:55,currentBet:1500,status:'ACTIVE',cards:[]}], actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:1500,description:'Bet 1500 (15 BB)'},potBefore:2000}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 1500')] }),
  },
  {
    id: 'aces-vs-short-shove', title: 'Pocket aces versus a short-stack shove', category: 'Preflop',
    expectedTypes: ['CALL'], note: 'With only fold or call available, folding AA to a short all-in is a basic strategic failure.',
    state: baseState({ hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:9600,stackBB:96,cards:['As','Ah'],currentBet:100}, pot:2550, actionHistory:[{street:'PREFLOP',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'RAISE',amount:2500,description:'All-in to 2500 (25 BB)'},potBefore:150}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:0,stackBB:0,currentBet:2500,status:'ALL_IN',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 2400')] }),
  },
  {
    id: 'seven-deuce-vs-shove', title: 'Seven-deuce offsuit versus a 100 BB shove', category: 'Preflop',
    expectedTypes: ['FOLD'], note: 'The weakest starting hand facing an enormous shove with little dead money should fold.',
    state: baseState({ hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:9900,stackBB:99,cards:['7c','2d'],currentBet:100}, pot:10150, actionHistory:[{street:'PREFLOP',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'RAISE',amount:10000,description:'All-in to 10000 (100 BB)'},potBefore:150}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:0,stackBB:0,currentBet:10000,status:'ALL_IN',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 9900')] }),
  },
  {
    id: 'river-air-overbet', title: 'Seven-high versus a 10× pot river shove', category: 'River discipline',
    expectedTypes: ['FOLD'], note: 'Hero has seven-high with no meaningful showdown value and faces an extreme overbet.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:10000,stackBB:100,cards:['7d','2d'],currentBet:0}, board:['Ac','Kh','Qh','9s','3c'], pot:1100, actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:10000,description:'All-in 10000 (100 BB)'},potBefore:1000}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:0,stackBB:0,currentBet:10000,status:'ALL_IN',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 10000')] }),
  },
  {
    id: 'nut-flush-tiny-bet', title: 'Nut flush versus a tiny river bet', category: 'Pot odds',
    expectedTypes: ['CALL'], note: 'Hero has the nut flush and faces a tiny bet; folding is an obvious sanity failure.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:9900,stackBB:99,cards:['As','8s'],currentBet:0}, board:['Ks','Qs','4s','2h','3d'], pot:1100, actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:100,description:'Bet 100 (1 BB)'},potBefore:1000}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:9900,stackBB:99,currentBet:100,status:'ACTIVE',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 100')] }),
  },
  {
    id: 'kings-vs-open', title: 'Pocket kings versus a normal open', category: 'Preflop',
    expectedTypes: ['CALL','RAISE'], note: 'Continuing with KK is expected; the suite accepts either calling or raising and rejects folding.',
    state: baseState({ hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:9900,stackBB:99,cards:['Kc','Kd'],currentBet:100}, pot:450, actionHistory:[{street:'PREFLOP',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'RAISE',amount:300,description:'Raise to 300 (3 BB)'},potBefore:150}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:9700,stackBB:97,currentBet:300,status:'ACTIVE',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 200'),action('A2','RAISE','Raise to 900 (9 BB)',900),action('A3','RAISE','Raise to 1200 (12 BB)',1200)] }),
  },
  {
    id: 'top-pair-tiny-river-bet', title: 'Top pair versus a 5% pot river bet', category: 'Pot odds',
    expectedTypes: ['CALL'], note: 'Top pair facing a tiny river bet gets overwhelming pot odds; folding is a basic sanity failure.',
    state: baseState({ street:'RIVER', hero:{id:'benchmark-hero',name:'Benchmark Hero',seat:1,position:'BB',stack:9950,stackBB:99.5,cards:['Ah','Jd'],currentBet:0}, board:['As','8c','6d','4h','2c'], pot:1050, actionHistory:[{street:'RIVER',playerName:'Benchmark Villain',position:'BTN/SB',action:{type:'BET',amount:50,description:'Bet 50 (0.5 BB)'},potBefore:1000}], opponents:[{seat:2,id:'benchmark-villain',name:'Benchmark Villain',stack:9950,stackBB:99.5,currentBet:50,status:'ACTIVE',cards:[]}], legalActions:[action('A0','FOLD','Fold'),action('A1','CALL','Call 50')] }),
  },
]);
