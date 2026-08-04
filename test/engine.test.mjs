// Engine rule tests — run with: node test/engine.test.mjs
import {
  N, ASCH, EMPTY, KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER,
  BONE, ASH, idx, colOf,
  initialState, genPseudo, genLegal, apply, attacked, isolationInfo,
  turnStartResult, claimableDraws, positionKey, serialize, deserialize, notateBody,
} from '../js/engine.js';
import { findBestMove, OPENINGS } from '../js/ai.js';

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
  ok(pm.filter(m => m.dash === 2).length === 11, 'all 11 Bürger have a two-square first move');
  ok(pm.filter(m => m.dash === 3).length === 11, 'all 11 Bürger have a three-square first move');
  // a blocked path cuts the first-move advance short
  const bb = emptyBoard();
  bb[idx(1, 2)] = BURGER * BONE;   // c2, unmoved
  bb[idx(4, 2)] = BURGER * ASH;    // c5 blocks the three-step only
  bb[idx(0, 5)] = KRONE * BONE;
  bb[idx(10, 5)] = KRONE * ASH;
  const bm = genPseudo(bb, BONE, false).filter(m => m.from === idx(1, 2));
  ok(bm.some(m => m.dash === 2) && !bm.some(m => m.dash === 3), 'first-move advance stops at an occupied square');
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

  // §2: a Bürger whose file runs into the Aschenstuhl steps around it
  const ba = emptyBoard();
  ba[idx(4, 5)] = BURGER * BONE;   // f5 — forward square is the throne
  ba[idx(6, 5)] = BURGER * ASH;    // f7 — likewise, from the other side
  ba[idx(0, 0)] = KRONE * BONE;
  ba[idx(10, 10)] = KRONE * ASH;
  const f5 = genPseudo(ba, BONE, false).filter(m => m.from === idx(4, 5));
  ok(f5.some(m => m.to === idx(5, 4)) && f5.some(m => m.to === idx(5, 6)),
    'f5 Bürger may step diagonally to e6/g6 without a capture');
  ok(!f5.some(m => m.to === ASCH), 'the throne itself stays forbidden');
  const f7 = genPseudo(ba, ASH, false).filter(m => m.from === idx(6, 5));
  ok(f7.some(m => m.to === idx(5, 4)) && f7.some(m => m.to === idx(5, 6)),
    'f7 Bürger may step diagonally to e6/g6 without a capture');
  // ...but only there: an ordinary Bürger has no free diagonal step
  const bo = emptyBoard();
  bo[idx(4, 4)] = BURGER * BONE;   // e5
  bo[idx(0, 0)] = KRONE * BONE;
  bo[idx(10, 10)] = KRONE * ASH;
  const e5 = genPseudo(bo, BONE, false).filter(m => m.from === idx(4, 4));
  ok(e5.length === 1 && e5[0].to === idx(5, 4), 'no free diagonal step away from the throne');
  // an own piece on the side-step square blocks it
  const bc = new Int8Array(ba);
  bc[idx(5, 4)] = MARSCHALL * BONE; // own piece on e6
  const f5b = genPseudo(bc, BONE, false).filter(m => m.from === idx(4, 5));
  ok(!f5b.some(m => m.to === idx(5, 4)) && f5b.some(m => m.to === idx(5, 6)),
    'side-step around the throne only onto an empty or enemy square');
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

  // enemy threat on an OWN-occupied square is only an idle gesture (§6)
  const b3 = new Int8Array(b2);
  b3[idx(3, 1)] = MARSCHALL * ASH; // b4: controls b2 (own pawn there) and b1 (blocked past b2)
  const info3 = isolationInfo(b3, BONE, false, true);
  ok(!info3.isolated && !info3.enemyTouch, 'a threat against an own-filled square completes nothing');

  // ...but a blade at the Krone's own throat does: fully self-walled, and an
  // enemy Gesandter leaps the wall to threaten a1 itself
  const b3g = new Int8Array(b2);
  b3g[idx(2, 1)] = GESANDTER * ASH; // b3: threatens a1 directly
  const info3g = isolationInfo(b3g, BONE, false, true);
  ok(info3g.isolated && info3g.enemyTouch, 'direct threat on the Krone’s own square completes Isolation');

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
  // Bone Krone a1 with a blade already at his throat (Ash Gesandter on c2
  // threatens a1); b1 is his last open square. Moving the own rook onto b1
  // would seal the wall and isolate him — that move must be illegal.
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;     // a1
  b[idx(1, 0)] = BURGER * BONE;    // a2
  b[idx(1, 1)] = BURGER * BONE;    // b2
  b[idx(0, 4)] = MARSCHALL * BONE; // e1 — can slide to b1
  b[idx(1, 2)] = GESANDTER * ASH;  // c2 threatens a1 directly
  b[idx(10, 10)] = KRONE * ASH;
  const before = isolationInfo(b, BONE, false, true);
  ok(!before.isolated && before.open.includes(idx(0, 1)), 'b1 is the last open square');
  ok(before.enemyTouch, 'the Krone’s own square is already threatened');
  const legal = genLegal(state(b));
  ok(!legal.some(m => m.from === idx(0, 4) && m.to === idx(0, 1)), 'may not voluntarily isolate own Krone');
  ok(legal.some(m => m.from === idx(0, 4)), 'rook still has other moves');
}

// --- the Krone cannot be taken --------------------------------------------
{
  // An Ash Marschall bearing straight down on the Bone Krone: threatening him
  // is legal; capturing him is not a move at all.
  const b = emptyBoard();
  b[idx(0, 5)] = KRONE * BONE;     // f1
  b[idx(2, 5)] = MARSCHALL * ASH;  // f3: threatens f1 through empty f2
  b[idx(10, 10)] = KRONE * ASH;
  ok(attacked(b, idx(0, 5), ASH), 'the Krone may stand threatened');
  const pm = genPseudo(b, ASH, false);
  ok(pm.some(m => m.from === idx(2, 5) && m.to === idx(1, 5)), 'the Marschall may advance to f2');
  ok(!pm.some(m => m.to === idx(0, 5)), 'no move may capture a Krone');
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

// --- notation ---------------------------------------------------------------
{
  const s = initialState();
  const dash = genPseudo(s.board, BONE, true).find(m => m.dash === 3 && colOf(m.from) === 5);
  ok(notateBody(s, dash) === 'f2»f5', 'dash notation f2»f5');
  const ba = emptyBoard();
  ba[idx(4, 5)] = BURGER * BONE;
  ba[idx(0, 0)] = KRONE * BONE;
  ba[idx(10, 10)] = KRONE * ASH;
  const ss = genPseudo(ba, BONE, false).find(m => m.sidestep && m.to === idx(5, 4));
  ok(notateBody(state(ba), ss) === 'f5↷e6', 'side-step notation f5↷e6');
}

// --- AI opening plans -------------------------------------------------------
{
  ok(OPENINGS.length === 5 && OPENINGS.every(o => o.line.length >= 3), 'five named openings defined');
  // A sound plan move from the start position is followed
  const s = initialState();
  const plan = { from: idx(1, 6), to: idx(2, 6) }; // g2-g3, the Closed Gate's first move
  const m = findBestMove(s, 'courtier', Math.random, plan);
  ok(m.from === plan.from && m.to === plan.to, 'AI follows a sound opening plan');
  // A plan move the board refutes (hanging the Kanzler to a Bürger) is refused
  const b = emptyBoard();
  b[idx(0, 5)] = KRONE * BONE;
  b[idx(10, 5)] = KRONE * ASH;
  b[idx(3, 3)] = KANZLER * BONE;
  b[idx(7, 2)] = BURGER * ASH;   // c8 guards d7
  const bad = { from: idx(3, 3), to: idx(6, 3) }; // Kanzler d4-d7, en prise
  const m2 = findBestMove(state(b), 'courtier', Math.random, bad);
  ok(!(m2.from === bad.from && m2.to === bad.to), 'AI abandons a plan the board refutes');
}

// --- AI -------------------------------------------------------------------
{
  const s = initialState();
  const m = findBestMove(s, 'courtier');
  ok(m && genLegal(s).some(x => x.from === m.from && x.to === m.to), 'AI produces a legal move');

  // AI finds a one-move isolation win. Bone Krone a1 fully self-walled
  // (a2/b2 Bürger, b1 Marschall) with no enemy touch yet; the Ash Gesandter
  // on d4 can leap to c2 or b3, either of which lays a blade at a1 itself.
  // Spymaster has zero jitter, so only the immediate wins tie for best.
  const b = emptyBoard();
  b[idx(0, 0)] = KRONE * BONE;     // a1
  b[idx(1, 0)] = BURGER * BONE;    // a2 own
  b[idx(1, 1)] = BURGER * BONE;    // b2 own
  b[idx(0, 1)] = MARSCHALL * BONE; // b1 own
  b[idx(3, 3)] = GESANDTER * ASH;  // d4
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
