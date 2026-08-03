// Kronspiel AI — iterative-deepening negamax with alpha-beta pruning.
// The evaluation is built around the game's actual win condition: material
// matters, but the number of open escape squares around each Krone matters more.

import {
  N, EMPTY, KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER,
  BONE, ASH, rowOf, colOf,
  genPseudo, attacked, isolationInfo, make, unmake, findKrone,
} from './engine.js';

const VALUES = {
  [BURGER]: 100, [GESANDTER]: 300, [PRALAT]: 315,
  [MARSCHALL]: 500, [KANZLER]: 900, [KRONE]: 0,
};

const WIN = 100000;

export const LEVELS = {
  novice: { maxDepth: 1, timeMs: 300, jitter: 60, blunder: 0.25 },
  courtier: { maxDepth: 3, timeMs: 700, jitter: 12, blunder: 0 },
  spymaster: { maxDepth: 5, timeMs: 1600, jitter: 0, blunder: 0 },
};

class Abort extends Error {}

function evaluate(board, side, fluchtMine, fluchtTheirs) {
  // Positive is good for `side` (the side to move at this leaf).
  let mat = 0;
  let adv = 0;
  let approach = 0;
  const kMine = findKrone(board, side);
  const kTheirs = findKrone(board, -side);
  const kr = rowOf(kTheirs), kc = colOf(kTheirs);
  for (let i = 0; i < N * N; i++) {
    const p = board[i];
    if (p === EMPTY) continue;
    const t = Math.abs(p);
    const s = Math.sign(p);
    mat += s * VALUES[t];
    if (t === BURGER) {
      // rows advanced from the home pawn rank
      const advance = s === BONE ? rowOf(i) - 1 : (N - 2) - rowOf(i);
      adv += s * advance * 5;
    } else if (t !== KRONE) {
      // nudge attackers toward the enemy Krone
      const target = s === side ? [kr, kc] : [rowOf(kMine), colOf(kMine)];
      const dist = Math.max(Math.abs(rowOf(i) - target[0]), Math.abs(colOf(i) - target[1]));
      approach += s * (10 - dist) * 2;
    }
  }

  const mine = isolationInfo(board, side, fluchtMine);
  const theirs = isolationInfo(board, -side, fluchtTheirs);
  let escapes = (Math.min(mine.open.length, 4) - Math.min(theirs.open.length, 4)) * 30;
  if (theirs.open.length <= 2) escapes += (3 - theirs.open.length) * 35;
  if (mine.open.length <= 2) escapes -= (3 - mine.open.length) * 35;
  // Fully walled in and one enemy touch from ruin
  if (theirs.open.length === 0 && !theirs.enemyTouch) escapes += 90;
  if (mine.open.length === 0 && !mine.enemyTouch) escapes -= 90;

  return side * (mat + adv + approach) + escapes;
}

function orderMoves(board, moves) {
  for (const m of moves) {
    const cap = board[m.to];
    m.score = cap === EMPTY
      ? 0
      : 10 * VALUES[Math.abs(cap)] - VALUES[Math.abs(board[m.from])];
    if (m.promo) m.score += 800;
  }
  moves.sort((a, b) => b.score - a.score);
  return moves;
}

export function findBestMove(state, level, rng = Math.random) {
  const opts = LEVELS[level] || LEVELS.courtier;
  const board = new Int8Array(state.board);
  const flucht = { [BONE]: state.flucht[BONE], [ASH]: state.flucht[ASH] };
  const deadline = Date.now() + opts.timeMs;
  let nodes = 0;

  function checkTime() {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Abort();
  }

  function search(side, fB, fA, depth, ply, alpha, beta) {
    checkTime();
    const fMine = side === BONE ? fB : fA;
    const fTheirs = side === BONE ? fA : fB;

    // Turn-start isolation check (§6): asked of the board as it stands.
    const iso = isolationInfo(board, side, fMine);
    if (iso.isolated) {
      const other = isolationInfo(board, -side, fTheirs);
      return other.isolated ? 0 : -(WIN - ply); // Mutual Ruin is a draw
    }
    if (depth === 0) return evaluate(board, side, fMine, fTheirs);

    const moves = orderMoves(board, genPseudo(board, side, fMine));
    let best = -Infinity;
    let anyLegal = false;
    for (const m of moves) {
      const u = make(board, m);
      const movedKrone = Math.abs(u.piece) === KRONE;
      const fMineAfter = fMine && !movedKrone;
      let legal = !(movedKrone && attacked(board, m.to, -side));
      if (legal && isolationInfo(board, side, fMineAfter).isolated) legal = false;
      if (!legal) { unmake(board, m, u); continue; }
      anyLegal = true;
      const nfB = side === BONE ? fMineAfter : fB;
      const nfA = side === ASH ? fMineAfter : fA;
      const v = -search(-side, nfB, nfA, depth - 1, ply + 1, -beta, -alpha);
      unmake(board, m, u);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    if (!anyLegal) return 0; // frozen court: treated as a draw
    return best;
  }

  // Root
  const rootMoves = orderMoves(board, genPseudo(board, state.turn, flucht[state.turn]));
  const legalRoot = [];
  for (const m of rootMoves) {
    const u = make(board, m);
    const movedKrone = Math.abs(u.piece) === KRONE;
    const fAfter = flucht[state.turn] && !movedKrone;
    let legal = !(movedKrone && attacked(board, m.to, -state.turn));
    if (legal && isolationInfo(board, state.turn, fAfter).isolated) legal = false;
    unmake(board, m, u);
    if (legal) legalRoot.push(m);
  }
  if (legalRoot.length === 0) return null;
  if (legalRoot.length === 1) return legalRoot[0];

  let bestByDepth = legalRoot.map((m) => ({ m, v: 0 }));
  try {
    for (let depth = 1; depth <= opts.maxDepth; depth++) {
      const scored = [];
      let alpha = -Infinity;
      for (const m of bestByDepth.map((x) => x.m)) {
        const u = make(board, m);
        const movedKrone = Math.abs(u.piece) === KRONE;
        const fAfter = flucht[state.turn] && !movedKrone;
        const nfB = state.turn === BONE ? fAfter : flucht[BONE];
        const nfA = state.turn === ASH ? fAfter : flucht[ASH];
        const v = -search(-state.turn, nfB, nfA, depth - 1, 1, -Infinity, -alpha);
        unmake(board, m, u);
        scored.push({ m, v });
        if (v > alpha) alpha = v;
      }
      scored.sort((a, b) => b.v - a.v);
      bestByDepth = scored; // ordered for the next iteration; kept if we run out of time
    }
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
  }

  // Personality: novices wobble, everyone else picks the best (with tiny jitter).
  const best = bestByDepth[0].v;
  if (opts.blunder > 0 && rng() < opts.blunder) {
    const pool = bestByDepth.filter((x) => x.v > -WIN / 2);
    return pool[Math.floor(rng() * pool.length)].m;
  }
  const pool = bestByDepth.filter((x) => x.v >= best - opts.jitter && x.v > -WIN / 2);
  const pick = pool.length ? pool[Math.floor(rng() * pool.length)] : bestByDepth[0];
  return pick.m;
}

// Quick static judgement of the position from `side`'s point of view,
// used to decide whether the AI accepts a Parley.
export function quickEval(state, side) {
  const board = new Int8Array(state.board);
  return evaluate(board, side, state.flucht[side], state.flucht[-side]);
}
