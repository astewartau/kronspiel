// Plays AI-vs-AI Kronspiel batches under a rule variant.
// Usage: node sim/run.mjs <variant> <games> <seedBase>
// Appends one JSON line per game to sim/out/<variant>.jsonl
import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const [, , name, nGamesArg = '32', seedBaseArg = '1000', timeMsArg = '90', maxDepthArg = '3', label = ''] = process.argv;
const nGames = +nGamesArg;
const seedBase = +seedBaseArg;

// variant -> which patched module set to load, plus harness-level rules
// The Palsied Court and the lifted-Krone test are core rules now — every
// variant inherits them from the live engine.
const CFG = {
  baseline: { dir: 'baseline', cfg: {} },
  hollow: { dir: 'baseline', cfg: { hollow: 10 } },
  loose: { dir: 'loose', cfg: {} },
  loosetruce: { dir: 'loose', cfg: { trucePly: 12 } },
  winter: { dir: 'winter', cfg: { winter: [[60, 0], [100, 1], [140, 2]] } },
  // The Flucht/Isolation question — Baseline vs Options A / B / C.
  'iso-base': { dir: 'baseline', cfg: {} },
  'iso-a': { dir: 'fluchtA', cfg: {} },
  'iso-b': { dir: 'fluchtB', cfg: {} },
  'iso-c': { dir: 'fluchtB', cfg: { softIso: true } },
};
if (!CFG[name]) { console.error('unknown variant', name); process.exit(1); }
const { dir, cfg } = CFG[name];

const engine = await import(`./variants/${dir}/engine.js`);
const ai = await import(`./variants/${dir}/ai.js`);
const { N, EMPTY, KRONE, BONE, ASH } = engine;

// Fast search profile: fixed shallow depth, small time slice, mild jitter for
// game diversity. Directional signal, not tournament strength.
ai.LEVELS.sim = { maxDepth: +maxDepthArg, timeMs: +timeMsArg, jitter: 12, blunder: 0, planMargin: 150 };

const PLY_CAP = 360;

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

// Freeze ring k (0 = outermost). Pieces on freezing squares are claimed by
// the winter; a Krone's square is spared (a pocket of bare ice).
function freezeRing(state, k) {
  let claimed = 0;
  for (let r = k; r < N - k; r++) {
    for (let c = k; c < N - k; c++) {
      if (r !== k && r !== N - 1 - k && c !== k && c !== N - 1 - k) continue;
      const i = r * N + c;
      const p = state.board[i];
      if (p !== EMPTY && Math.abs(p) === KRONE) continue;
      if (p !== EMPTY) { state.board[i] = EMPTY; claimed++; }
      engine.FROZEN.add(i);
    }
  }
  return claimed;
}

// A turn skipped during the opening truce (no legal move while the truce
// suspends isolation): hand the move over.
function passTurn(s) {
  const ns = {
    board: s.board, turn: -s.turn, flucht: s.flucht,
    clock: s.clock + 1, reps: { ...s.reps }, ply: s.ply + 1,
  };
  const k = engine.positionKey(ns);
  ns.reps[k] = (ns.reps[k] || 0) + 1;
  return ns;
}

function playGame(seed) {
  engine.FROZEN?.clear();
  let state = engine.initialState();
  const rng = mulberry32(seed);
  const bareTurns = { [BONE]: 0, [ASH]: 0 };
  const frozenRings = new Set();
  let truceSaves = 0;
  let claimed = 0;
  let softIsoCount = 0; // Option C: turns a Krone was forced to flee
  let fluchtCount = 0;  // Flucht leaps actually played

  for (;;) {
    if (cfg.winter) {
      for (const [ply, ring] of cfg.winter) {
        if (state.ply >= ply && !frozenRings.has(ring)) {
          frozenRings.add(ring);
          claimed += freezeRing(state, ring);
        }
      }
    }

    const { board, turn, flucht, ply } = state;
    const inTruce = cfg.trucePly && ply < cfg.trucePly;
    const mine = engine.isolationInfo(board, turn, flucht[turn], true);

    if (mine.isolated && !inTruce) {
      const theirs = engine.isolationInfo(board, -turn, flucht[-turn], true);
      return theirs.isolated
        ? { type: 'mutual', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount }
        : { type: 'isolation', loser: turn, plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    }

    const myBare = bare(board, turn), theirBare = bare(board, -turn);
    if (myBare && theirBare) return { type: 'empty', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    if (cfg.hollow) {
      if (myBare) {
        bareTurns[turn]++;
        if (bareTurns[turn] > cfg.hollow) return { type: 'hollow', loser: turn, plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
      }
    }

    const legal = engine.genLegal(state);
    if (legal.length === 0) {
      if (inTruce) { truceSaves++; state = passTurn(state); continue; }
      if (mine.enemyTouch) {
        return { type: 'palsy', loser: turn, plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
      }
      return { type: 'frozen', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    }

    if ((state.reps[engine.positionKey(state)] || 0) >= 3) return { type: 'siege', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    if (state.clock >= 100) return { type: 'winterdraw', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    if (ply >= PLY_CAP) return { type: 'cap', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };

    let m;
    if (cfg.softIso && flucht[turn] && engine.isolationInfo(board, turn, false, true).isolated) {
      // Soft Isolation (Option C): saved from Isolation only by Die Flucht — the
      // Krone must flee this turn (the one exception to no reaction time).
      softIsoCount++;
      const fl = legal.filter((x) => x.flucht);
      const pick = fl.reduce((best, mv) => {
        const v = ai.quickEval(engine.apply(state, mv), turn);
        return best && best.v >= v ? best : { mv, v };
      }, null);
      m = pick ? pick.mv : ai.findBestMove(state, 'sim', rng);
    } else {
      m = ai.findBestMove(state, 'sim', rng);
    }
    if (!m) return { type: 'frozen', plies: ply, truceSaves, claimed, soft: softIsoCount, flucht: fluchtCount };
    if (m.flucht) fluchtCount++;
    state = engine.apply(state, m);
  }
}

await mkdir(join(HERE, 'out'), { recursive: true });
const outFile = join(HERE, 'out', `${name}${label}.jsonl`);
const t0 = Date.now();
for (let g = 0; g < nGames; g++) {
  const seed = seedBase + g;
  const res = playGame(seed);
  await appendFile(outFile, JSON.stringify({ variant: name, seed, ...res }) + '\n');
  console.log(`${name} ${g + 1}/${nGames}: ${res.type}${res.loser ? ' loser=' + (res.loser === 1 ? 'bone' : 'ash') : ''} plies=${res.plies} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
console.log(`${name} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
