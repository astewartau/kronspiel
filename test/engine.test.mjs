// Engine rule tests — run with: node test/engine.test.mjs
import {
  N, ASCH, EMPTY, KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER,
  BONE, ASH, idx,
  initialState, genPseudo, genLegal, apply, attacked, isolationInfo,
  turnStartResult, claimableDraws, positionKey, serialize, deserialize,
} from '../js/engine.js';
import { findBestMove } from '../js/ai.js';

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; }
  else { failed++; console.error('FAIL:', name); }
}

function emptyBoard() { return new Int8Array(N * N); }
function state(board, turn = BONE, flucht = { [BONE]: false, [ASH]: false }) {
  return { board, turn, flucht, clock: 0, reps: {}, ply: 0 };
}

// --- setup -------------------------------------------------------------
{
  const s = initialState();
  ok(s.board[idx(0, 5)] === KRONE * BONE, 'Bone Krone at f1');
  ok(s.board[idx(10, 5)] === KRONE * ASH, 'Ash Krone at f11');
  ok(s.board[idx(0, 0)] === EMPTY && s.board[idx(0, 10)] === EMPTY, 'Wings open');
  ok(s.board[idx(0, 4)] === KANZLER && s.board[idx(0, 6)] === KANZLER, 'Twin Kanzler flank the Krone');
  let bone = 0, ash = 0;
  for (const p of s.board) { if (p > 0) bone++; if (p < 0) ash++; }
  ok(bone === 20 && ash === 20, '20 pieces per side');
  ok(s.board[ASCH] === EMPTY, 'Aschenstuhl empty');
  // start position: surrounded but NOT isolated (condition 2 unmet)
  const info = isolationInfo(s.board, BONE, true, true);
  ok(info.open.length === 0 && !info.enemyTouch && !info.isolated, 'start: walled in by own court, not isolated');
  ok(turnStartResult(s, genLegal(s)) === null, 'start: no result');
}

// --- Aschenstuhl -------------------------------------------------------
{
  const b = emptyBoard();
  b[idx(5, 0)] = KANZLER * BONE;   // same row as the Aschenstuhl
  b[idx(0, 0)] = KRONE * BONE;
  b[idx(10, 10)] = KRONE * ASH;
  // Kanzler at a6 cannot see past f6 (ASCH) to k6
  ok(!attacked(b, idx(5, 10), BONE), 'slider cannot see past the Aschenstuhl');
  ok(attacked(b, idx(5, 4), BONE), 'slider sees up to the Aschenstuhl');
  const moves = genPseudo(b, BONE, false).filter(m => m.from === idx(5, 0));
  ok(!moves.some(m => m.to === ASCH), 'no piece may land on the Aschenstuhl');
  ok(!moves.some(m => m.to === idx(5, 6)), 'no slide through the Aschenstuhl');

  // Gesandter leaps over it but cannot land on it
  const b2 = emptyBoard();
  b2[idx(4, 4)] = GESANDTER * BONE;
  b2[idx(0, 0)] = KRONE * BONE;
  b2[idx(10, 10)] = KRONE * ASH;
  const gm = genPseudo(b2, BONE, false).filter(m => m.from === idx(4, 4));
  ok(!gm.some(m => m.to === ASCH), 'Gesandter cannot land on the Aschenstuhl');
  ok(gm.some(m => m.to === idx(6, 5)), 'Gesandter leap unaffected by the Aschenstuhl');
}

// --- Bürger ------------------------------------------------------------
{
  const s = initialState();
  const pm = genPseudo(s.board, BONE, true).filter(m => Math.abs(s.board[m.from]) === BURGER);
  ok(pm.filter(m => m.double).length === 11, 'all 11 Bürger have a double step');
  // promotion: only to Gesandter
  const b = emptyBoard();
  b[idx(9, 0)] = BURGER * BONE;
  b[idx(0, 5)] = KRONE * BONE;
  b[idx(10, 10)] = KRONE * ASH;
  const promos = genPseudo(b, BONE, false).filter(m => m.promo);
  ok(promos.length === 1, 'promotion move generated');
  const st = state(b);
  const after = apply(st, promos[0]);
  ok(after.board[idx(10, 0)] === GESANDTER * BONE, 'Bürger promotes only to Gesandter');
}

// --- Die Flucht ---------------------------------------------------------
{
  const b = emptyBoard();
  b[idx(0, 5)] = KRONE * BONE;
  b[idx(10, 5)] = KRONE * ASH;
  const fm = genPseudo(b, BONE, true).filter(m => m.flucht && m.from === idx(0, 5));
  // up: f3, f4; sideways: d1/h1... along row: e1?? flucht dist>=2: d1,c1? from f1: left to e1(d1?) — distances 2,3 each direction within board
  ok(fm.some(m => m.to === idx(2, 5)) && fm.some(m => m.to === idx(3, 5)), 'Flucht: 2 or 3 forward');
  ok(fm.some(m => m.to === idx(0, 3)) && fm.some(m => m.to === idx(0, 2)), 'Flucht: 2 or 3 leftward');
  ok(!fm.some(m => m.to === idx(1, 6)), 'Flucht is orthogonal only');

  // threatened path blocks Flucht
  const b2 = new Int8Array(b);
  b2[idx(1, 0)] = MARSCHALL * ASH; // controls row 2 -> square f2 threatened
  const fm2 = genPseudo(b2, BONE, true).filter(m => m.flucht && m.from === idx(0, 5));
  ok(!fm2.some(m => m.to === idx(2, 5)), 'Flucht blocked by a threatened pass-through square');

  // once the Krone moves, no flucht rights
  const st = state(b, BONE, { [BONE]: true, [ASH]: true });
  const kMove = genLegal(st).find(m => m.from === idx(0, 5) && m.to === idx(0, 4));
  const after = apply(st, kMove);
  ok(after.flucht[BONE] === false, 'Krone move forfeits Die Flucht');
  ok(after.flucht[ASH] === true, "opponent's Flucht unaffected");
}

// --- Krone movement restrictions ----------------------------------------
{
  const b = emptyBoard();
  b[idx(0, 5)] = KRONE * BONE;
  b[idx(10, 5)] = KRONE * ASH;
  b[idx(2, 4)] = MARSCHALL * ASH; // controls column e and row 3
  const legal = genLegal(state(b));
  ok(!legal.some(m => m.from === idx(0, 5) && m.to === idx(0, 4)), 'Krone may not step into an enemy line');
  ok(legal.some(m => m.from === idx(0, 5) && m.to === idx(0, 6)), 'Krone may step to a safe square');
  // Krone can capture an undefended adjacent piece
  const b2 = emptyBoard();
  b2[idx(0, 5)] = KRONE * BONE;
  b2[idx(1, 5)] = BURGER * ASH;
  b2[idx(10, 5)] = KRONE * ASH;
  ok(genLegal(state(b2)).some(m => m.from === idx(0, 5) && m.to === idx(1, 5)), 'Krone captures undefended piece');
  // ...but not a defended one
  const b3 = new Int8Array(b2);
  b3[idx(2, 6)] = BURGER * ASH; // defends e2? pawn at g3 (ash) attacks f2 — ash pawn moves -r, attacks (r-1,c±1) → (1,5) yes
  ok(!genLegal(state(b3)).some(m => m.from === idx(0, 5) && m.to === idx(1, 5)), 'Krone may not capture a defended piece');
}

// --- Isolation ----------------------------------------------------------
{
  // Krone in the corner, own pieces on b1/b2, enemy threat on a2 — isolated
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;   // a1
  b[idx(0, 1)] = MARSCHALL * BONE; // b1 own
  b[idx(1, 1)] = BURGER * BONE;    // b2 own
  b[idx(3, 0)] = MARSCHALL * ASH;  // a4: controls a2 (a3? a-file down to a2)
  b[idx(10, 10)] = KRONE * ASH;
  const info = isolationInfo(b, BONE, false, true);
  ok(info.isolated, 'corner Krone: own wall + one enemy line = isolated');
  ok(info.enemyTouch, 'enemy touch detected');

  // same, but no enemy involvement — NOT isolated
  const b2 = new Int8Array(b);
  b2[idx(3, 0)] = EMPTY;
  b2[idx(1, 0)] = BURGER * BONE; // a2 own piece: fully self-walled
  const info2 = isolationInfo(b2, BONE, false, true);
  ok(!info2.isolated && !info2.enemyTouch, 'a Krone is never undone by his own house alone');

  // enemy threat on an OWN-occupied square counts for condition 2
  const b3 = new Int8Array(b2);
  b3[idx(3, 1)] = MARSCHALL * ASH; // b4: controls b2 (own pawn there) and b1(blocked by b2 pawn)
  const info3 = isolationInfo(b3, BONE, false, true);
  ok(info3.isolated, 'siege of an own-occupied square completes Isolation');

  // Flucht as the last escape: a1 Krone, own pawns a2/b2, enemy Prälat on d3
  // threatening b1. Without Flucht: every neighbour closed, enemy touch on b1
  // → isolated. With Flucht: row 1 is physically clear, so c1/d1 count as
  // escape squares (§6) even though b1, the pass-through, is threatened.
  const b4 = emptyBoard();
  b4[idx(0, 0)] = KRONE * BONE;
  b4[idx(1, 0)] = BURGER * BONE;
  b4[idx(1, 1)] = BURGER * BONE;
  b4[idx(2, 3)] = PRALAT * ASH;   // d3: threatens c2 and b1
  b4[idx(10, 10)] = KRONE * ASH;
  const noFlucht = isolationInfo(b4, BONE, false, true);
  const withFlucht = isolationInfo(b4, BONE, true, true);
  ok(noFlucht.isolated, 'without Flucht: isolated');
  ok(!withFlucht.isolated, 'an unused Flucht can be the last escape');
  ok(withFlucht.open.includes(idx(0, 2)) && withFlucht.open.includes(idx(0, 3)),
    'Flucht squares counted despite the threatened pass-through');

  // turn-start detection
  const st = state(b, BONE);
  const r = turnStartResult(st, genLegal(st));
  ok(r && r.type === 'isolation' && r.loser === BONE, 'turnStartResult reports isolation');
}

// --- no self-isolation ---------------------------------------------------
{
  // Bone Krone a1; own rook at b2; own pawn a2. Moving the rook to b1 would
  // complete his own wall while an enemy threatens... construct:
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;     // a1
  b[idx(1, 0)] = BURGER * BONE;    // a2
  b[idx(1, 1)] = BURGER * BONE;    // b2
  b[idx(5, 1)] = MARSCHALL * BONE; // b6 — can move to b1
  b[idx(3, 0)] = MARSCHALL * ASH;  // a4 threatens a3->a2(occupied) — touches a2 → enemyTouch
  b[idx(10, 10)] = KRONE * ASH;
  // b1 currently open (not attacked: ASH rook on a-file doesn't hit b1)
  const before = isolationInfo(b, BONE, false, true);
  ok(!before.isolated && before.open.includes(idx(0, 1)), 'b1 is the last open square');
  const legal = genLegal(state(b));
  ok(!legal.some(m => m.from === idx(5, 1) && m.to === idx(0, 1)), 'may not voluntarily isolate own Krone');
  ok(legal.some(m => m.from === idx(5, 1)), 'rook still has other moves');
}

// --- draws ----------------------------------------------------------------
{
  // Empty court
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;
  b[idx(10, 10)] = KRONE * ASH;
  const st = state(b);
  const r = turnStartResult(st, genLegal(st));
  ok(r && r.type === 'empty', 'lone Krone vs lone Krone is the Empty Court');

  // Long Winter counter
  let s = initialState();
  const g1 = genLegal(s).find(m => Math.abs(s.board[m.from]) === GESANDTER);
  s = apply(s, g1);
  ok(s.clock === 1, 'clock ticks on quiet moves');
  const p1 = genLegal(s).find(m => Math.abs(s.board[m.from]) === BURGER);
  s = apply(s, p1);
  ok(s.clock === 0, 'clock resets on a Bürger move');
  ok(!claimableDraws(s).longWinter, 'no premature Long Winter');

  // repetition key stability
  const a = initialState();
  const bkey = positionKey(a);
  const a2 = deserialize(serialize(a));
  ok(positionKey(a2) === bkey, 'serialize/deserialize preserves the position');
}

// --- mutual ruin -----------------------------------------------------------
{
  // both kings sealed, both under enemy touch
  const b = emptyBoard();
  // Bone Krone a1: a2,b2 own; b1 threatened by ash rook on b-file far away
  b[idx(0, 0)] = KRONE * BONE;
  b[idx(1, 0)] = BURGER * BONE;
  b[idx(1, 1)] = BURGER * BONE;
  b[idx(6, 1)] = MARSCHALL * ASH; // b7: controls b1? b-file down: b6..b2(occupied by bone pawn at b2) — stops at b2. So b1 NOT threatened. Use rook on row 0: k1
  b[idx(0, 10)] = MARSCHALL * ASH; // k1: row 1 → threatens b1 (row clear from k1 to b1?) squares c1..j1 empty → yes
  // Ash Krone k11: j11, j10 own ash; k10 threatened by bone rook on k-file? place bone rook at k5: controls k10? k-file from k5 up: k6..k9 empty, k10 → yes (k11 blocked beyond)
  b[idx(10, 10)] = KRONE * ASH;
  b[idx(10, 9)] = BURGER * ASH;
  b[idx(9, 9)] = BURGER * ASH;
  b[idx(4, 10)] = MARSCHALL * BONE;
  const infoB = isolationInfo(b, BONE, false);
  const infoA = isolationInfo(b, ASH, false);
  ok(infoB.isolated && infoA.isolated, 'both Krone isolated');
  const st = state(b, BONE);
  const r = turnStartResult(st, []);
  ok(r && r.type === 'mutual', 'Mutual Ruin is a draw');
}

// --- AI -------------------------------------------------------------------
{
  const s = initialState();
  const m = findBestMove(s, 'courtier');
  ok(m && genLegal(s).some(x => x.from === m.from && x.to === m.to), 'AI produces a legal move');

  // AI finds a one-move isolation win. Bone Krone a1 fully self-walled
  // (a2/b2 Bürger, b1 Marschall) but with no enemy touch yet; the Ash
  // Kanzler on e8 threatens none of those squares, and can win at once
  // (e.g. e8–e2 touches b2 along the second rank, e8–b5 down the b-file).
  // Spymaster has zero jitter, so only the immediate wins tie for best.
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;     // a1
  b[idx(1, 0)] = BURGER * BONE;    // a2 own
  b[idx(1, 1)] = BURGER * BONE;    // b2 own
  b[idx(0, 1)] = MARSCHALL * BONE; // b1 own
  b[idx(7, 4)] = KANZLER * ASH;    // e8
  b[idx(10, 10)] = KRONE * ASH;
  const st2 = state(b, ASH, { [BONE]: false, [ASH]: false });
  ok(!isolationInfo(st2.board, BONE, false).isolated, 'test position: Bone not yet isolated');
  const mv = findBestMove(st2, 'spymaster');
  const after = apply(st2, mv);
  const rr = turnStartResult(after, genLegal(after));
  ok(rr && rr.type === 'isolation' && rr.loser === BONE, 'AI finds a one-move Isolation');
}

// --- AI self-play smoke test -----------------------------------------------
{
  let s = initialState();
  let ended = null;
  for (let i = 0; i < 30; i++) {
    const legal = genLegal(s);
    const r = turnStartResult(s, legal);
    if (r) { ended = r; break; }
    const m = findBestMove(s, 'novice');
    if (!m) break;
    s = apply(s, m);
  }
  ok(true, `self-play smoke test ran (${ended ? 'ended: ' + ended.type : '30 plies, no crash'})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
