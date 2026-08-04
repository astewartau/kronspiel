// Opening study for Kronspiel.
//
//   node sim/openings.mjs analyze <plies...>      score all legal moves after a forced prefix
//   node sim/openings.mjs book <opening> <n> <s>  Bone plays the scripted line, Ash plays free
//   node sim/openings.mjs first <move> <n> <s>    only Bone's first move is forced
//   node sim/openings.mjs free <n> <s> [label]    free play control, movelists recorded
//
// Results land in sim/out/op-*.jsonl, one line per game, full movelist included.
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , mode, ...rest] = process.argv;

const useAnalysis = mode === 'analyze';
const engine = await import(useAnalysis ? './variants/analysis/engine.js' : '../js/engine.js');
const ai = await import(useAnalysis ? './variants/analysis/ai.js' : '../js/ai.js');
const { N, EMPTY, KRONE, BONE, ASH, idx, sqName } = engine;

// The five named openings of §8, as scripted in js/ai.js (Bone coordinates).
const LINES = {
  closedgate: ['g2-g3', 'e2-e3', 'c1-e2', 'i1-g2', 'f2-f3'],
  sigismund: ['b2-b5', 'b1-b4', 'b4-f4'],
  ashen: ['f2-f3', 'e2-e3', 'g2-g3', 'e1-e2', 'g1-g2'],
  drowned: ['j2-j4', 'i1-j3', 'i2-i3', 'b2-b4', 'b1-b3'],
  beggars: ['a2-a4', 'k2-k4', 'a4-a5', 'k4-k5'],
};

ai.LEVELS.study = { maxDepth: 4, timeMs: 200, jitter: 12, blunder: 0, planMargin: 150 };
ai.LEVELS.oracle = { maxDepth: 8, timeMs: 90000, jitter: 0, blunder: 0, planMargin: 0 };

const PLY_CAP = 360;
const FILES = 'abcdefghijk';

function parseMove(txt) {
  const m = txt.match(/^([a-k])(\d+)-([a-k])(\d+)$/);
  if (!m) throw new Error('bad move ' + txt);
  return { from: idx(+m[2] - 1, FILES.indexOf(m[1])), to: idx(+m[4] - 1, FILES.indexOf(m[3])) };
}
const mvName = (m) => sqName(m.from) + '-' + sqName(m.to);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bare = (board, side) => {
  for (let i = 0; i < N * N; i++) {
    const p = board[i];
    if (p !== EMPTY && Math.sign(p) === side && Math.abs(p) !== KRONE) return false;
  }
  return true;
};

// One game. `script` is an array of Bone move texts to force while legal.
function playGame(seed, script = []) {
  let state = engine.initialState();
  const rng = mulberry32(seed);
  const moves = [];
  let bi = 0, bookPlayed = 0, evalAfterBook = null;

  for (;;) {
    const { board, turn, flucht, ply } = state;
    const mine = engine.isolationInfo(board, turn, flucht[turn], true);
    if (mine.isolated) {
      const theirs = engine.isolationInfo(board, -turn, flucht[-turn], true);
      const type = theirs.isolated ? 'mutual' : 'isolation';
      return { type, loser: type === 'isolation' ? turn : undefined, plies: ply, bookPlayed, evalAfterBook, moves };
    }
    if (bare(board, turn) && bare(board, -turn)) return { type: 'empty', plies: ply, bookPlayed, evalAfterBook, moves };
    const legal = engine.genLegal(state);
    if (legal.length === 0) return { type: 'frozen', plies: ply, bookPlayed, evalAfterBook, moves };
    if ((state.reps[engine.positionKey(state)] || 0) >= 3) return { type: 'siege', plies: ply, bookPlayed, evalAfterBook, moves };
    if (state.clock >= 100) return { type: 'winterdraw', plies: ply, bookPlayed, evalAfterBook, moves };
    if (ply >= PLY_CAP) return { type: 'cap', plies: ply, bookPlayed, evalAfterBook, moves };

    let m = null;
    if ((turn === BONE || script.duo) && bi < script.length) {
      const want = parseMove(script[bi]);
      m = legal.find((x) => x.from === want.from && x.to === want.to) || null;
      if (m) { bi++; bookPlayed++; }
      else bi = Infinity; // the line is broken; abandon the book
    }
    if (!m) m = ai.findBestMove(state, 'study', rng);
    if (!m) return { type: 'frozen', plies: ply, bookPlayed, evalAfterBook, moves };
    moves.push(mvName(m));
    state = engine.apply(state, m);
    if (bookPlayed === script.length && script.length && evalAfterBook === null) {
      evalAfterBook = ai.quickEval(state, BONE);
    }
  }
}

await mkdir(join(HERE, 'out'), { recursive: true });

async function batch(file, tag, games, seedBase, script) {
  const out = join(HERE, 'out', file);
  const t0 = Date.now();
  for (let g = 0; g < games; g++) {
    const res = playGame(seedBase + g, script);
    await appendFile(out, JSON.stringify({ tag, seed: seedBase + g, ...res }) + '\n');
    console.log(`${tag} ${g + 1}/${games}: ${res.type}${res.loser ? ' loser=' + (res.loser === 1 ? 'bone' : 'ash') : ''} plies=${res.plies} book=${res.bookPlayed} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`${tag} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

if (mode === 'book') {
  const [name, n = '24', seed = '11000'] = rest;
  if (!LINES[name]) { console.error('unknown opening; use', Object.keys(LINES).join(' ')); process.exit(1); }
  await batch(`op-book-${name}.jsonl`, `book:${name}`, +n, +seed, LINES[name]);
} else if (mode === 'first') {
  const [move, n = '16', seed = '13000'] = rest;
  await batch(`op-first-${move}.jsonl`, `first:${move}`, +n, +seed, [move]);
} else if (mode === 'line') {
  const [name, movesCsv, n = '20', seed = '14000'] = rest;
  await batch(`op-line-${name}.jsonl`, `line:${name}`, +n, +seed, movesCsv.split(','));
} else if (mode === 'duo') {
  // Script forces the opening for BOTH sides (alternating plies), then free play.
  const [name, movesCsv, n = '20', seed = '15000'] = rest;
  const script = movesCsv.split(',');
  script.duo = true;
  await batch(`op-duo-${name}.jsonl`, `duo:${name}`, +n, +seed, script);
} else if (mode === 'free') {
  const [n = '24', seed = '12000', label = ''] = rest;
  await batch(`op-free${label}.jsonl`, 'free', +n, +seed, []);
} else if (mode === 'analyze') {
  // Force the given prefix (alternating Bone/Ash), then score every legal move.
  let state = engine.initialState();
  for (const txt of rest) {
    const want = parseMove(txt);
    const m = engine.genLegal(state).find((x) => x.from === want.from && x.to === want.to);
    if (!m) throw new Error('illegal prefix move ' + txt);
    state = engine.apply(state, m);
  }
  console.log(`analyzing after [${rest.join(' ')}] — ${state.turn === BONE ? 'Bone' : 'Ash'} to move`);
  const t0 = Date.now();
  ai.findBestMove(state, 'oracle', () => 0);
  const scores = ai.findBestMove.lastScores;
  console.log(`searched ${((Date.now() - t0) / 1000).toFixed(0)}s, ${scores.length} moves`);
  for (const s of scores.slice(0, 15)) {
    console.log(`${sqName(s.from)}-${sqName(s.to)}`.padEnd(9), String(s.v).padStart(6));
  }
  console.log('...worst:', ...scores.slice(-3).map((s) => `${sqName(s.from)}-${sqName(s.to)}:${s.v}`));
} else {
  console.error('modes: analyze | book | first | free');
  process.exit(1);
}
