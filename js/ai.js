// Kronspiel AI — iterative-deepening negamax with alpha-beta pruning,
// a quiescence search, and a transposition table (Zobrist-hashed).
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
// Terminal (isolation/mate) scores are ply-relative, so they must never be
// cached and reused at a different depth. We simply refuse to store them.
const MATE_GUARD = WIN - 1000;

export const LEVELS = {
  novice: { maxDepth: 1, timeMs: 300, jitter: 60, blunder: 0.25, planMargin: 250 },
  courtier: { maxDepth: 3, timeMs: 700, jitter: 12, blunder: 0, planMargin: 150 },
  spymaster: { maxDepth: 6, timeMs: 1600, jitter: 0, blunder: 0, planMargin: 90 },
};

// A fixed, difficulty-independent budget for the move-quality feedback: honest
// analysis should not get weaker just because you picked an easier opponent.
export const ANALYSIS = { maxDepth: 5, timeMs: 450, jitter: 0, blunder: 0, planMargin: 0 };

// Named openings (§8) as scripted own-side plans, in Bone coordinates —
// mirrored when the Court commands Ash. A plan move is only played while it
// stays within `planMargin` of the search's best answer; a deviation or a
// tactically punished line abandons the book.
export const OPENINGS = [
  { name: 'the Closed Gate', line: ['g2-g3', 'e2-e3', 'c1-e2', 'i1-g2', 'f2-f3'] },
  { name: 'the Sigismund Gambit', line: ['b2-b5', 'b1-b4', 'b4-f4'] },
  { name: 'the Ashen Approach', line: ['f2-f3', 'e2-e3', 'g2-g3', 'e1-e2', 'g1-g2'] },
  { name: 'the Drowned Flank', line: ['j2-j4', 'i1-j3', 'i2-i3', 'b2-b4', 'b1-b3'] },
  { name: "the Beggar's Gate", line: ['a2-a4', 'k2-k4', 'a4-a5', 'k4-k5'] },
];

class Abort extends Error {}

// --- Zobrist hashing --------------------------------------------------------
// Two independent 32-bit tables give an effective 64-bit key: collisions
// between distinct positions are vanishingly rare. Filled from a fixed PRNG so
// hashes are stable run-to-run (useful for testing TT correctness).
function makeZobrist() {
  let s = 0x9e3779b9 >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s >>> 0; };
  const z1 = [], z2 = [];
  for (let sq = 0; sq < N * N; sq++) {
    z1[sq] = new Uint32Array(13);
    z2[sq] = new Uint32Array(13);
    for (let p = 1; p < 13; p++) { z1[sq][p] = rnd(); z2[sq][p] = rnd(); }
  }
  return { z1, z2 };
}
const { z1: ZOB1, z2: ZOB2 } = makeZobrist();
// Signed piece value -> table slot 1..12.
const pieceCode = (p) => (Math.abs(p) - 1) * 2 + (p < 0 ? 1 : 0) + 1;

const TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
const TT_CAP = 1 << 19; // bound memory; cleared wholesale when exceeded

function evaluate(board, side, fluchtMine, fluchtTheirs) {
  // Positive is good for `side` (the side to move at this leaf).
  const mine = isolationInfo(board, side, fluchtMine);
  const theirs = isolationInfo(board, -side, fluchtTheirs);
  const kMine = mine.kSq;
  const kTheirs = theirs.kSq;
  const kr = rowOf(kTheirs), kc = colOf(kTheirs);
  const mr = rowOf(kMine), mc = colOf(kMine);
  // How boxed-in each Krone already is decides whether crowding it is worth
  // anything: chase the king only when the chase is actually closing doors.
  const gate = (open) => (open <= 2 ? 1 : open <= 4 ? 0.6 : 0.3);
  const gTheirs = gate(theirs.open.length);
  const gMine = gate(mine.open.length);

  let mat = 0;
  let adv = 0;
  let approach = 0;
  let hang = 0;
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
      // Nudge attackers toward the enemy Krone — but only weakly until the
      // enemy Krone is genuinely short of escapes, so the AI stops flinging
      // pieces at a king it cannot yet trap. The Gesandter pulls hardest: it is
      // the one piece that can lay a blade at a self-walled Krone's throat (§6).
      const own = s === side;
      const target = own ? [kr, kc] : [mr, mc];
      const g = own ? gTheirs : gMine;
      const dist = Math.max(Math.abs(rowOf(i) - target[0]), Math.abs(colOf(i) - target[1]));
      approach += s * (10 - dist) * (t === GESANDTER ? 2.5 : 1.5) * g;
      // Hanging-piece guard: a minor or major left where the enemy can take it
      // for free (attacked, undefended) is a leaf-level blunder the static eval
      // must see, or the search happily walks into it just beyond the horizon.
      if (attacked(board, i, -s) && !attacked(board, i, s)) hang -= s * VALUES[t] * 0.5;
    }
  }

  let escapes = (Math.min(mine.open.length, 4) - Math.min(theirs.open.length, 4)) * 30;
  if (theirs.open.length <= 2) escapes += (3 - theirs.open.length) * 35;
  if (mine.open.length <= 2) escapes -= (3 - mine.open.length) * 35;
  // Fully walled in and one enemy touch from ruin
  if (theirs.open.length === 0 && !theirs.enemyTouch) escapes += 90;
  if (mine.open.length === 0 && !mine.enemyTouch) escapes -= 90;
  // Near-isolation pressure: the enemy already has a hand in (a blade at the
  // throat or a claimed empty door) while the escapes run out
  if (theirs.enemyTouch && theirs.open.length <= 1) escapes += 45;
  if (mine.enemyTouch && mine.open.length <= 1) escapes -= 45;

  return side * (mat + adv + approach + hang) + escapes;
}

function orderMoves(board, moves, ttMove) {
  for (const m of moves) {
    const cap = board[m.to];
    m.score = cap === EMPTY
      ? 0
      : 10 * VALUES[Math.abs(cap)] - VALUES[Math.abs(board[m.from])];
    if (m.promo) m.score += 800;
    // The transposition table's remembered best move is tried first of all.
    if (ttMove && m.from === ttMove.from && m.to === ttMove.to) m.score += 1e6;
  }
  moves.sort((a, b) => b.score - a.score);
  return moves;
}

// Runs iterative-deepening search from `state` under `opts`, returning the root
// moves scored best-first (and the raw legal list). Shared by the move-picker
// and the analysis hook.
function coreSearch(state, opts) {
  const board = new Int8Array(state.board);
  const flucht = { [BONE]: state.flucht[BONE], [ASH]: state.flucht[ASH] };
  const deadline = Date.now() + opts.timeMs;
  let nodes = 0;
  let h1 = 0, h2 = 0;
  const tt = new Map();

  function computeHash() {
    h1 = 0; h2 = 0;
    for (let sq = 0; sq < N * N; sq++) {
      const p = board[sq];
      if (p === EMPTY) continue;
      const c = pieceCode(p);
      h1 = (h1 ^ ZOB1[sq][c]) >>> 0;
      h2 = (h2 ^ ZOB2[sq][c]) >>> 0;
    }
  }
  // Toggle the hash for a move — its own inverse, so calling it again reverts.
  function applyHash(m, u) {
    const fromC = pieceCode(u.piece);
    h1 = (h1 ^ ZOB1[m.from][fromC]) >>> 0; h2 = (h2 ^ ZOB2[m.from][fromC]) >>> 0;
    if (u.captured !== EMPTY) {
      const cc = pieceCode(u.captured);
      h1 = (h1 ^ ZOB1[m.to][cc]) >>> 0; h2 = (h2 ^ ZOB2[m.to][cc]) >>> 0;
    }
    const placed = m.promo ? GESANDTER * Math.sign(u.piece) : u.piece;
    const pc = pieceCode(placed);
    h1 = (h1 ^ ZOB1[m.to][pc]) >>> 0; h2 = (h2 ^ ZOB2[m.to][pc]) >>> 0;
  }
  const tkey = (side, fB, fA) => h1 + '_' + h2 + '_' + (side === BONE ? 'b' : 'a') + (fB ? 1 : 0) + (fA ? 1 : 0);

  function checkTime() {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new Abort();
  }

  // Resolve pending captures/promotions before trusting the static eval, so the
  // search never scores a position with a piece hanging mid-exchange.
  function quiesce(side, fB, fA, ply, alpha, beta) {
    checkTime();
    const fMine = side === BONE ? fB : fA;
    const fTheirs = side === BONE ? fA : fB;
    const iso = isolationInfo(board, side, fMine);
    if (iso.isolated) {
      const other = isolationInfo(board, -side, fTheirs);
      return other.isolated ? 0 : -(WIN - ply);
    }
    // Fail-soft: return the value found, never a raw window bound — a `beta`
    // return would leak the caller's window (e.g. a mate score) into positions
    // that are nothing of the sort.
    let best = evaluate(board, side, fMine, fTheirs);
    if (best >= beta) return best;
    if (best > alpha) alpha = best;

    const moves = orderMoves(board, genPseudo(board, side, fMine), null)
      .filter((m) => board[m.to] !== EMPTY || m.promo);
    for (const m of moves) {
      const u = make(board, m);
      const movedKrone = Math.abs(u.piece) === KRONE;
      const fMineAfter = fMine && !movedKrone;
      let legal = !(movedKrone && attacked(board, m.to, -side));
      if (legal && isolationInfo(board, side, fMineAfter).isolated) legal = false;
      if (!legal) { unmake(board, m, u); continue; }
      const nfB = side === BONE ? fMineAfter : fB;
      const nfA = side === ASH ? fMineAfter : fA;
      const v = -quiesce(-side, nfB, nfA, ply + 1, -beta, -alpha);
      unmake(board, m, u);
      if (v > best) best = v;
      if (v >= beta) return best;
      if (v > alpha) alpha = v;
    }
    return best;
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
    if (depth <= 0) return quiesce(side, fB, fA, ply, alpha, beta);

    const alphaOrig = alpha;
    const key = tkey(side, fB, fA);
    const e = tt.get(key);
    let ttMove = null;
    if (e) {
      ttMove = e.best;
      if (e.d >= depth) {
        if (e.flag === TT_EXACT) return e.v;
        if (e.flag === TT_LOWER) { if (e.v > alpha) alpha = e.v; }
        else if (e.flag === TT_UPPER) { if (e.v < beta) beta = e.v; }
        if (alpha >= beta) return e.v;
      }
    }

    // Soft Isolation (§6): saved from Isolation only by Die Flucht (we passed the
    // check above), the Krone must flee — nothing else is legal this turn.
    const forcedFlee = fMine && iso.enemyTouch && isolationInfo(board, side, false).isolated;

    const moves = orderMoves(board, genPseudo(board, side, fMine), ttMove);
    let best = -Infinity;
    let bestMove = null;
    let anyLegal = false;
    for (const m of moves) {
      if (forcedFlee && !m.flucht) continue;
      const u = make(board, m);
      applyHash(m, u);
      const movedKrone = Math.abs(u.piece) === KRONE;
      const fMineAfter = fMine && !movedKrone;
      let legal = !(movedKrone && attacked(board, m.to, -side));
      if (legal && isolationInfo(board, side, fMineAfter).isolated) legal = false;
      if (!legal) { applyHash(m, u); unmake(board, m, u); continue; }
      anyLegal = true;
      const nfB = side === BONE ? fMineAfter : fB;
      const nfA = side === ASH ? fMineAfter : fA;
      const v = -search(-side, nfB, nfA, depth - 1, ply + 1, -beta, -alpha);
      applyHash(m, u);
      unmake(board, m, u);
      if (v > best) { best = v; bestMove = m; }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    if (!anyLegal) return iso.enemyTouch ? -(WIN - ply) : 0; // Palsied Court loses; Frozen Court draws

    if (Math.abs(best) < MATE_GUARD) {
      const flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
      if (tt.size >= TT_CAP) tt.clear();
      tt.set(key, { d: depth, v: best, flag, best: bestMove ? { from: bestMove.from, to: bestMove.to } : null });
    }
    return best;
  }

  // Root ---------------------------------------------------------------------
  const rootIso = isolationInfo(board, state.turn, flucht[state.turn]);
  const rootFlee = flucht[state.turn] && rootIso.enemyTouch && !rootIso.isolated
    && isolationInfo(board, state.turn, false).isolated;
  const rootMoves = orderMoves(board, genPseudo(board, state.turn, flucht[state.turn]), null);
  const legalRoot = [];
  for (const m of rootMoves) {
    if (rootFlee && !m.flucht) continue;
    const u = make(board, m);
    const movedKrone = Math.abs(u.piece) === KRONE;
    const fAfter = flucht[state.turn] && !movedKrone;
    let legal = !(movedKrone && attacked(board, m.to, -state.turn));
    if (legal && isolationInfo(board, state.turn, fAfter).isolated) legal = false;
    unmake(board, m, u);
    if (legal) legalRoot.push(m);
  }
  if (legalRoot.length === 0) return { legalRoot, bestByDepth: [] };
  if (legalRoot.length === 1) return { legalRoot, bestByDepth: [{ m: legalRoot[0], v: 0, forced: true }] };

  computeHash();
  let bestByDepth = legalRoot.map((m) => ({ m, v: 0 }));
  try {
    for (let depth = 1; depth <= opts.maxDepth; depth++) {
      const scored = [];
      // Every root move gets a full window, so each `v` is an exact score — the
      // move-quality feedback needs true per-move values, and it keeps a losing
      // move from inheriting the best move's window bound (mate scores especially).
      for (const m of bestByDepth.map((x) => x.m)) {
        const u = make(board, m);
        applyHash(m, u);
        const movedKrone = Math.abs(u.piece) === KRONE;
        const fAfter = flucht[state.turn] && !movedKrone;
        const nfB = state.turn === BONE ? fAfter : flucht[BONE];
        const nfA = state.turn === ASH ? fAfter : flucht[ASH];
        const v = -search(-state.turn, nfB, nfA, depth - 1, 1, -Infinity, Infinity);
        applyHash(m, u);
        unmake(board, m, u);
        scored.push({ m, v });
      }
      scored.sort((a, b) => b.v - a.v);
      bestByDepth = scored; // ordered for the next iteration; kept if we run out of time
    }
  } catch (err) {
    if (!(err instanceof Abort)) throw err;
  }
  return { legalRoot, bestByDepth };
}

// `planMove` ({from, to}, optional): the next move of a scripted opening.
// It is played only if legal and within planMargin of the best root score.
export function findBestMove(state, level, rng = Math.random, planMove = null) {
  const opts = LEVELS[level] || LEVELS.courtier;
  const { legalRoot, bestByDepth } = coreSearch(state, opts);
  if (legalRoot.length === 0) return null;
  if (legalRoot.length === 1) return legalRoot[0];

  // A court playing its opening keeps to the script while the script holds up.
  const best = bestByDepth[0].v;
  if (planMove) {
    const planned = bestByDepth.find((x) => x.m.from === planMove.from && x.m.to === planMove.to);
    if (planned && planned.v > -WIN / 2 && planned.v >= best - opts.planMargin) return planned.m;
  }

  // Personality: novices wobble, everyone else picks the best (with tiny jitter).
  if (opts.blunder > 0 && rng() < opts.blunder) {
    const pool = bestByDepth.filter((x) => x.v > -WIN / 2);
    return pool[Math.floor(rng() * pool.length)].m;
  }
  const pool = bestByDepth.filter((x) => x.v >= best - opts.jitter && x.v > -WIN / 2);
  const pick = pool.length ? pool[Math.floor(rng() * pool.length)] : bestByDepth[0];
  return pick.m;
}

// Search the position and report the best line plus every root move's score,
// from the side-to-move's point of view. Drives the live move-quality feedback.
// Returns { terminal, singleton, best, bestMove, scored: [{from, to, v}] }.
export function analyse(state, opts = ANALYSIS) {
  const { legalRoot, bestByDepth } = coreSearch(state, opts);
  if (legalRoot.length === 0) return { terminal: true, singleton: false, best: null, bestMove: null, scored: [] };
  const scored = bestByDepth.map((x) => ({ from: x.m.from, to: x.m.to, v: x.v }));
  return {
    terminal: false,
    singleton: legalRoot.length === 1,
    best: bestByDepth[0].v,
    bestMove: { from: bestByDepth[0].m.from, to: bestByDepth[0].m.to },
    scored,
  };
}

// Quick static judgement of the position from `side`'s point of view,
// used to decide whether the AI accepts a Parley.
export function quickEval(state, side) {
  const board = new Int8Array(state.board);
  return evaluate(board, side, state.flucht[side], state.flucht[-side]);
}
