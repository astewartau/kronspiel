// Kronspiel UI — rendering, interaction, game flow.

import {
  N, ASCH, EMPTY, KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER, BONE, ASH,
  idx, rowOf, colOf, sqName, GLYPHS,
  initialState, genPseudo, genLegal, apply, make, attacked, turnStartResult,
  claimableDraws, isolationInfo, softIsolation, findKrone, notateBody, serialize, deserialize, positionKey,
} from './engine.js';
import { findBestMove, quickEval, OPENINGS } from './ai.js';
import { PIECE_SETS, pieceHTML, sigilInner } from './pieces.js';
import { Net, makeCode, normalizeCode } from './net.js';
import { LESSONS, buildTutState, sqOf } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'kronspiel-save-v1';
const PREFS_KEY = 'kronspiel-prefs-v1';

// ---------------------------------------------------------------------------
// Game session state
// ---------------------------------------------------------------------------

let settings = { mode: 'hotseat', humanSide: BONE, level: 'courtier' };
let prefs = { pieceSet: 'sigils' }; // boardLabels left unset → device default (hidden on mobile)
let hist = [];          // engine states, hist[hist.length-1] is current
let logEntries = [];    // [{ply, side, text}]
let capturedBy = { [BONE]: [], [ASH]: [] }; // piece types captured BY each side
let result = null;      // {type, loser?, winner?, label, text}
let flipped = false;
let selection = null;   // selected square index
let legalCache = [];    // legal moves for current position
let lastMove = null;    // {from, to}
let aiThinking = false;
let parleyPending = false;

// Online play
let net = null;          // Net instance while an online session is live
let oppHere = false;     // the other court is connected
let hostRetries = 0;     // room-code collision retries

let noticeText = null;   // transient substatus line: illegal-move hints, opening announcements
let tut = null;          // { step } while the Primer is running
let aiOpening = null;    // the Court's scripted opening for this game, or null

const cur = () => hist[hist.length - 1];
const sideName = (s) => (s === BONE ? 'The Bone Court' : 'The Ash Court');
const isAiTurn = () => settings.mode === 'ai' && !result && cur().turn === -settings.humanSide;
const isOnline = () => settings.mode === 'online';
const isTutorial = () => settings.mode === 'tutorial';
// Soft Isolation: the side to move is besieged and must take Die Flucht this turn.
const softFlee = () => !result && !isTutorial() && softIsolation(cur().board, cur().turn, cur().flucht[cur().turn]);

// ---------------------------------------------------------------------------
// Board DOM
// ---------------------------------------------------------------------------

const boardEl = $('board');
const piecesEl = $('pieces');
const squares = [];     // index -> element
let pieceEls = new Map(); // square index -> piece element

function buildBoard() {
  // Squares are appended in display order; mapping to board indices happens in sqAt.
  for (let disp = 0; disp < N * N; disp++) {
    const el = document.createElement('div');
    el.className = 'sq';
    boardEl.insertBefore(el, piecesEl);
    squares.push(el);
  }
  boardEl.addEventListener('click', onBoardClick);
  layoutBoard();
}

// Display row/col (0 = top-left of screen) -> board index
function dispToSq(dr, dc) {
  const r = flipped ? dr : N - 1 - dr;
  const c = flipped ? N - 1 - dc : dc;
  return idx(r, c);
}

function sqToDisp(sq) {
  const r = rowOf(sq), c = colOf(sq);
  return {
    dr: flipped ? r : N - 1 - r,
    dc: flipped ? N - 1 - c : c,
  };
}

function layoutBoard() {
  for (let disp = 0; disp < N * N; disp++) {
    const dr = Math.floor(disp / N), dc = disp % N;
    const sq = dispToSq(dr, dc);
    const el = squares[disp];
    el.dataset.sq = sq;
    const light = (rowOf(sq) + colOf(sq)) % 2 === 1;
    el.className = 'sq ' + (sq === ASCH ? 'asch' : light ? 'bone' : 'ash');
  }
  // rank & file labels
  const files = 'abcdefghijk'.split('');
  const ranks = Array.from({ length: N }, (_, i) => i + 1);
  const fileSeq = flipped ? files.slice().reverse() : files;
  const rankSeq = flipped ? ranks : ranks.slice().reverse();
  $('files').innerHTML = fileSeq.map((f) => `<span>${f}</span>`).join('');
  $('ranks').innerHTML = rankSeq.map((r) => `<span>${r}</span>`).join('');
  syncPieces();
  paint();
  renderAnno(); // square-anchored marks follow the flip
}

function placePiece(el, sq) {
  const { dr, dc } = sqToDisp(sq);
  el.style.transform = `translate(${dc * 100}%, ${dr * 100}%)`;
}

function makePieceEl(val, sq) {
  const el = document.createElement('div');
  el.className = 'piece ' + (val > 0 ? 'bone-piece' : 'ash-piece');
  el.innerHTML = pieceHTML(prefs.pieceSet, Math.abs(val));
  placePiece(el, sq);
  piecesEl.appendChild(el);
  return el;
}

// Rebuild the piece layer from scratch (new game, undo, load, flip)
function syncPieces() {
  piecesEl.innerHTML = '';
  pieceEls = new Map();
  const b = cur().board;
  for (let i = 0; i < N * N; i++) {
    if (b[i] !== EMPTY) pieceEls.set(i, makePieceEl(b[i], i));
  }
}

// Animate a single move that has just been applied (stateAfter is current)
function animateMove(m) {
  const el = pieceEls.get(m.from);
  const target = pieceEls.get(m.to);
  if (target) {
    target.classList.add('captured-anim');
    setTimeout(() => target.remove(), 260);
    pieceEls.delete(m.to);
  }
  if (el) {
    el.classList.add('moving');
    placePiece(el, m.to);
    pieceEls.delete(m.from);
    pieceEls.set(m.to, el);
    setTimeout(() => {
      el.classList.remove('moving');
      if (m.promo) el.innerHTML = pieceHTML(prefs.pieceSet, GESANDTER);
    }, 230);
  }
  if (m.promo && !el) syncPieces();
}

// ---------------------------------------------------------------------------
// Painting (highlights, badges, status)
// ---------------------------------------------------------------------------

function paint() {
  const state = cur();
  const showEsc = $('chk-escapes').checked;
  const escInfo = showEsc && !result
    ? isolationInfo(state.board, state.turn, state.flucht[state.turn], true)
    : null;
  const doom = result && (result.type === 'isolation' || result.type === 'mutual' || result.type === 'palsy') ? result.info : null;

  const legalFrom = selection !== null
    ? legalCache.filter((m) => m.from === selection)
    : [];

  const warnInfo = !result
    ? isolationInfo(state.board, state.turn, state.flucht[state.turn], true)
    : null;

  const tutMarks = tut ? tutMarkSet() : null;

  for (const el of squares) {
    const sq = +el.dataset.sq;
    el.classList.remove('sel', 'move', 'capture', 'flucht-target', 'last-from', 'last-to',
      'esc-open', 'esc-enemy', 'esc-own', 'doom-enemy', 'doom-own', 'doom-krone', 'krone-warn', 'krone-flee', 'tut-mark');
    if (tutMarks && tutMarks.has(sq)) el.classList.add('tut-mark');
    if (lastMove) {
      if (sq === lastMove.from) el.classList.add('last-from');
      if (sq === lastMove.to) el.classList.add('last-to');
    }
    if (selection === sq) el.classList.add('sel');
    const mv = legalFrom.find((m) => m.to === sq);
    if (mv) {
      el.classList.add(state.board[sq] !== EMPTY ? 'capture' : 'move');
      if (mv.flucht) el.classList.add('flucht-target');
    }
    if (escInfo) {
      if (escInfo.open.includes(sq)) el.classList.add('esc-open');
      const cl = escInfo.closed.find((x) => x.sq === sq);
      if (cl && !cl.asch) {
        el.classList.add(cl.occ === 'enemy' || cl.threat ? 'esc-enemy' : 'esc-own');
      }
    }
    if (doom) {
      if (sq === doom.kSq) el.classList.add('doom-krone');
      const cl = doom.closed.find((x) => x.sq === sq);
      if (cl && !cl.asch) el.classList.add(cl.occ === 'enemy' || cl.threat ? 'doom-enemy' : 'doom-own');
    }
  }

  // low-escape warning on the Krone itself — only once the enemy is at the wall
  if (warnInfo && warnInfo.open.length <= 1 && warnInfo.enemyTouch && !doom) {
    const el = squares.find((s) => +s.dataset.sq === warnInfo.kSq);
    if (el) el.classList.add('krone-warn');
  }

  // Soft Isolation: mark the Krone who must flee this turn.
  if (softFlee()) {
    const el = squares.find((s) => +s.dataset.sq === findKrone(state.board, state.turn));
    if (el) { el.classList.remove('krone-warn'); el.classList.add('krone-flee'); }
  }

  paintTutArrows();

  paintBars();
  paintStatus();
  paintControls();
}

function paintBars() {
  const state = cur();
  const topSide = flipped ? BONE : ASH;
  const botSide = -topSide;

  const bars = [
    { bar: $('bar-top'), name: $('name-top'), esc: $('esc-top'), cap: $('cap-top'), sig: $('bar-top').querySelector('.court-sigil'), side: topSide },
    { bar: $('bar-bottom'), name: $('name-bottom'), esc: $('esc-bottom'), cap: $('cap-bottom'), sig: $('bar-bottom').querySelector('.court-sigil'), side: botSide },
  ];
  for (const { bar, name, esc, cap, sig, side } of bars) {
    let label = sideName(side);
    if (settings.mode === 'ai') {
      label += side === settings.humanSide ? ' · You' : ' · The Court';
    } else if (isOnline()) {
      label += side === settings.humanSide ? ' · You' : ' · The Other Court';
    }
    name.textContent = label;
    sig.className = 'court-sigil ' + (side === BONE ? 'bone' : 'ash');
    sig.innerHTML = pieceHTML(prefs.pieceSet, KRONE);
    bar.classList.toggle('active', !result && state.turn === side);
    const info = isolationInfo(state.board, side, state.flucht[side], true);
    const n = info.open.length;
    esc.textContent = `${n} escape${n === 1 ? '' : 's'}`;
    esc.classList.toggle('tight', n <= 2);
    // captured pieces: pieces this side has taken (of the enemy's colour)
    const taken = capturedBy[side];
    cap.innerHTML = taken
      .map((t) => `<span class="${side === BONE ? 'ash-piece' : 'bone-piece'}">${pieceHTML(prefs.pieceSet, t)}</span>`)
      .join('');
  }
}

function paintStatus() {
  const st = $('status'), sub = $('substatus'), fs = $('focus-status');
  st.classList.toggle('thinking', aiThinking);
  fs.classList.toggle('thinking', aiThinking);
  paintWinterClock();
  if (isTutorial()) {
    st.textContent = 'The Primer';
    fs.textContent = 'The Primer';
    sub.textContent = noticeText || '';
    return;
  }
  if (result) {
    st.textContent = result.label;
    fs.textContent = result.label;
    sub.textContent = result.short || '';
    return;
  }
  const state = cur();
  if (aiThinking) {
    st.textContent = 'The Court deliberates';
    fs.textContent = 'The Court deliberates';
    sub.textContent = '';
    return;
  }
  if (isOnline() && !oppHere) {
    const t = net && net.role === 'host' ? 'Awaiting the other court.' : 'The line is severed.';
    st.textContent = t;
    fs.textContent = t;
    sub.textContent = net && net.role === 'host'
      ? 'Share the room code to fill the empty seat.'
      : 'Rejoin from New Game → Online with the same code.';
    return;
  }
  st.textContent = `${sideName(state.turn)} to move.`;
  fs.textContent = st.textContent;
  if (softFlee()) {
    st.textContent = `${sideName(state.turn)} — the Krone must flee!`;
    fs.textContent = st.textContent;
    sub.textContent = noticeText
      || 'Besieged on every side and saved only by Die Flucht — the Krone must take his one leap now.';
    return;
  }
  if (noticeText) {
    sub.textContent = noticeText;
    return;
  }
  const info = isolationInfo(state.board, state.turn, state.flucht[state.turn], true);
  if (info.open.length === 0) {
    sub.textContent = 'The Krone stands walled in by his own court — one enemy touch from ruin.';
  } else if (info.open.length <= 2 && info.enemyTouch) {
    sub.textContent = 'The Krone’s ground is narrowing.';
  } else if (state.flucht[state.turn]) {
    sub.textContent = 'Die Flucht remains prepared.';
  } else {
    sub.textContent = '';
  }
}

// The Long Winter approaches: surface the silent-move clock once it matters.
function paintWinterClock() {
  const el = $('winter-clock');
  const clock = cur().clock;
  const show = !result && !isTutorial() && clock >= 60;
  el.classList.toggle('hidden', !show);
  if (show) {
    el.textContent = `The Long Winter nears — ${Math.floor(clock / 2)} of 50 silent moves.`;
  }
}

function paintControls() {
  const interactive = !result && !aiThinking && !isTutorial();
  $('btn-undo').disabled = hist.length < 2 || aiThinking || isOnline() || isTutorial();
  $('btn-focus-undo').disabled = $('btn-undo').disabled;
  $('btn-parley').disabled = !interactive || (isOnline() && !oppHere);
  $('btn-resign').disabled = !interactive || (isOnline() && !oppHere);
  const claims = interactive ? claimableDraws(cur()) : { longSiege: false, longWinter: false };
  const humanCanClaim = settings.mode === 'hotseat' || isOnline() || cur().turn === settings.humanSide;
  $('btn-siege').classList.toggle('hidden', !(claims.longSiege && humanCanClaim));
  $('btn-winter').classList.toggle('hidden', !(claims.longWinter && humanCanClaim));
  $('claims').classList.toggle('hidden',
    $('btn-siege').classList.contains('hidden') && $('btn-winter').classList.contains('hidden'));
}

function logSpan(entry, cls) {
  const span = document.createElement('span');
  span.className = 'm ' + cls;
  if (entry.text) {
    span.textContent = entry.text; // entries from saves made before piece styles
  } else {
    span.innerHTML = pieceHTML(prefs.pieceSet, entry.piece) + ' ' + entry.body;
  }
  return span;
}

function paintLog() {
  const ol = $('movelog');
  ol.innerHTML = '';
  for (let i = 0; i < logEntries.length; i += 2) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = (i / 2 + 1) + '.';
    const m1 = logSpan(logEntries[i], 'bone-piece');
    li.append(n, m1);
    if (logEntries[i + 1]) li.append(logSpan(logEntries[i + 1], 'ash-piece'));
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function onBoardClick(e) {
  if (annotating || editing || viewing) return; // annotate / edit / replay modes own the board
  const sqEl = e.target.closest('.sq');
  if (!sqEl || result || aiThinking) return;
  if (settings.mode === 'ai' && cur().turn !== settings.humanSide) return;
  if (isOnline() && (!oppHere || !net?.connected || cur().turn !== settings.humanSide)) return;
  if (isTutorial() && (!LESSONS[tut.step]?.expect || tut.done)) return; // narration steps (and a lesson already answered): the board rests
  const sq = +sqEl.dataset.sq;
  const state = cur();
  noticeText = null;

  if (selection !== null) {
    const mv = legalCache.find((m) => m.from === selection && m.to === sq);
    if (mv) {
      if (isTutorial() && !tutAllows(mv)) {
        noticeText = LESSONS[tut.step].expect.hint;
        selection = null;
        paint();
        return;
      }
      selection = null;
      playMove(mv);
      return;
    }
    // Not a legal destination — explain why, when there is a why (§6 safeguards)
    const hint = illegalHint(selection, sq);
    if (hint) noticeText = hint;
  }
  const p = state.board[sq];
  if (p !== EMPTY && Math.sign(p) === state.turn) {
    selection = selection === sq ? null : sq;
  } else {
    selection = null;
  }
  paint();
}

// If from→to fits the piece's movement but is barred by a rule, say which rule.
function illegalHint(from, to) {
  const state = cur();
  const p = state.board[from];
  if (p === EMPTY || Math.sign(p) !== state.turn) return null;
  const q = state.board[to];
  if (q !== EMPTY && Math.abs(q) === KRONE && Math.sign(q) === -state.turn) {
    // reachable if the same square held an ordinary piece?
    const probe = new Int8Array(state.board);
    probe[to] = BURGER * -state.turn;
    if (genPseudo(probe, state.turn, false).some((m) => m.from === from && m.to === to)) {
      return 'The Krone cannot be taken. Only Isolation ends his reign.';
    }
    return null;
  }
  if (Math.abs(p) === KRONE && q !== EMPTY && Math.sign(q) === -state.turn) {
    const dr = Math.abs(rowOf(from) - rowOf(to)), dc = Math.abs(colOf(from) - colOf(to));
    if (dr <= 1 && dc <= 1) return 'The Krone takes no one. He moves only onto open ground.';
  }
  const pm = genPseudo(state.board, state.turn, state.flucht[state.turn])
    .find((m) => m.from === from && m.to === to);
  if (!pm) return null; // not that piece's move at all — no lecture needed
  const b = new Int8Array(state.board);
  const u = make(b, pm);
  const movedKrone = Math.abs(u.piece) === KRONE;
  if (movedKrone && attacked(b, pm.to, -state.turn)) {
    return 'The Krone may never step into an enemy’s line.';
  }
  const fluchtAfter = state.flucht[state.turn] && !movedKrone;
  if (isolationInfo(b, state.turn, fluchtAfter).isolated) {
    return 'Forbidden — that move would isolate your own Krone.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function playMove(m, fromRemote = false) {
  const before = cur();
  noticeText = null;
  clearAnno(); // a fresh position wipes any lingering marks
  if (isOnline() && !fromRemote) {
    net?.send({ t: 'move', m: { from: m.from, to: m.to }, ply: before.ply });
  }
  const capturedVal = before.board[m.to];
  const entry = {
    ply: before.ply,
    side: before.turn,
    piece: Math.abs(before.board[m.from]),
    body: notateBody(before, m),
  };
  const next = apply(before, m);
  hist.push(next);
  logEntries.push(entry);
  if (capturedVal !== EMPTY) capturedBy[before.turn].push(Math.abs(capturedVal));
  lastMove = { from: m.from, to: m.to };
  animateMove(m);
  afterPositionChange();
}

function afterPositionChange() {
  const state = cur();
  legalCache = result ? [] : genLegal(state);

  if (isTutorial()) {
    // No results, no AI, no saving: the Primer narrates its own endings.
    paint();
    paintLog();
    if (tut && LESSONS[tut.step]?.expect && !tut.done) {
      // The asked-for move was made. Let it be seen — the lesson waits, and
      // Continue appears once the piece has settled.
      tut.done = true;
      const step = tut.step;
      setTimeout(() => {
        if (!tut || tut.step !== step || !tut.done) return;
        const btn = $('btn-tutor-next');
        btn.classList.remove('hidden');
        btn.classList.add('reveal');
      }, 550);
    }
    return;
  }

  if (!result) {
    const end = turnStartResult(state, legalCache);
    if (end) setResult(end);
  }

  // Soft Isolation: pre-select the Krone so his forced Flucht squares are shown.
  if (!result && softFlee() && !isAiTurn()) selection = findKrone(state.board, state.turn);

  paint();
  paintLog();
  save();

  if (!result && isAiTurn()) scheduleAiMove();
}

function setResult(end) {
  const r = { type: end.type, info: end.info || null };
  switch (end.type) {
    case 'isolation': {
      const loser = end.loser;
      r.label = `Isolation — ${sideName(-loser)} prevails.`;
      r.title = 'Isolation';
      r.text = `The ${loser === BONE ? 'Bone' : 'Ash'} Krone has nowhere left to stand. ` +
        'It does not matter that no hand was ever laid upon him; the board has admitted what every court eventually must.';
      r.short = `${sideName(loser)}’s Krone is isolated.`;
      break;
    }
    case 'mutual':
      r.label = 'Mutual Ruin — the game is drawn.';
      r.title = 'Mutual Ruin';
      r.text = 'Both Krone stand isolated in the same instant. Older players consider this the most honest outcome the board can produce, and the least common by a wide margin.';
      break;
    case 'empty':
      r.label = 'The Empty Court — the game is drawn.';
      r.title = 'The Empty Court';
      r.text = 'Two crowns, no court, and nothing left with which to build a wall. The game is drawn automatically.';
      break;
    case 'palsy': {
      const loser = end.loser;
      r.label = `The Palsied Court — ${sideName(-loser)} prevails.`;
      r.title = 'The Palsied Court';
      r.text = `The ${loser === BONE ? 'Bone' : 'Ash'} court has no legal move left to make, and the enemy's hand is already on the wall. ` +
        'A court that cannot act while under siege has already fallen; the board merely admits it.';
      r.short = `${sideName(loser)}’s court is palsied.`;
      break;
    }
    case 'frozen':
      r.label = 'The Frozen Court — the game is drawn.';
      r.title = 'The Frozen Court';
      r.text = 'No legal move remains, yet no enemy hand touches the wall — the court has simply choked itself still. With no siege to answer for it, the game is drawn.';
      break;
    case 'siege':
      r.label = 'The Long Siege — the game is drawn.';
      r.title = 'The Long Siege';
      r.text = 'The same position, the same player to move, a third time. Nothing new remains to be said with these pieces.';
      break;
    case 'winter':
      r.label = 'The Long Winter — the game is drawn.';
      r.title = 'The Long Winter';
      r.text = 'Fifty moves by each side without a Bürger stirred or a piece taken. The campaign has starved.';
      break;
    case 'parley':
      r.label = 'Parley — the game is drawn.';
      r.title = 'Parley';
      r.text = 'A draw agreed between the players, as courtesies go: rarely offered from kindness, rarely refused from strength.';
      break;
    case 'resign': {
      const loser = end.loser;
      r.label = `${sideName(loser)} resigns — ${sideName(-loser)} prevails.`;
      r.title = 'Resignation';
      r.text = `${sideName(loser)} concedes the board. A throne yielded is no less lost than a throne besieged.`;
      break;
    }
  }
  result = r;
  selection = null;
  legalCache = [];
  showGameOver();
}

function showGameOver() {
  $('over-title').textContent = result.title;
  $('over-text').textContent = result.text;
  const rematch = $('btn-over-rematch');
  rematch.classList.toggle('hidden', !isOnline() || !net?.connected);
  rematch.disabled = false;
  $('btn-over-review').classList.toggle('hidden', hist.length < 2); // nothing to review without moves
  $('ov-over').classList.remove('hidden');
  $('btn-show-result').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

// The Court's next scripted opening move, translated to board squares
// (mirrored when the Court commands Ash), or null once off-book.
function aiPlanMove() {
  if (!aiOpening) return null;
  const aiSide = -settings.humanSide;
  const played = logEntries.filter((e) => e.side === aiSide).length;
  const text = aiOpening.line[played];
  if (!text) return null;
  const [a, b] = text.split('-');
  const mirror = (name) => {
    const r = parseInt(name.slice(1), 10) - 1;
    const c = name.charCodeAt(0) - 97;
    return aiSide === BONE ? idx(r, c) : idx(N - 1 - r, c);
  };
  return { from: mirror(a), to: mirror(b) };
}

function scheduleAiMove() {
  aiThinking = true;
  paint();
  const started = Date.now();
  setTimeout(() => {
    const plan = aiPlanMove();
    const m = findBestMove(cur(), settings.level, Math.random, plan);
    const elapsed = Date.now() - started;
    const wait = Math.max(0, 450 - elapsed); // let the court appear to think
    setTimeout(() => {
      aiThinking = false;
      if (m && !result) {
        const onBook = plan && m.from === plan.from && m.to === plan.to;
        const firstBookMove = onBook && logEntries.filter((e) => e.side === -settings.humanSide).length === 0;
        if (plan && !onBook) aiOpening = null; // the script no longer fits the board
        playMove(m);
        if (firstBookMove) {
          noticeText = `The Court essays ${aiOpening.name}.`;
          paintStatus();
        }
      } else if (!result) {
        afterPositionChange();
      }
    }, wait);
  }, 60);
}

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

function newGame(fresh) {
  if (fresh) {
    if (viewing) leaveViewingUi();
    clearAnno();
    hist = [initialState()];
    logEntries = [];
    capturedBy = { [BONE]: [], [ASH]: [] };
    result = null;
    lastMove = null;
    selection = null;
    aiThinking = false;
    noticeText = null;
    // The Court picks an opening to essay — novices sometimes just wing it.
    aiOpening = settings.mode === 'ai' && !(settings.level === 'novice' && Math.random() < 0.4)
      ? OPENINGS[Math.floor(Math.random() * OPENINGS.length)]
      : null;
  }
  syncPieces();
  legalCache = result ? [] : genLegal(cur());
  paint();
  paintLog();
  save();
  if (!result && isAiTurn()) scheduleAiMove();
}

function undo() {
  if (hist.length < 2 || aiThinking || isOnline()) return;
  const pops = settings.mode === 'ai'
    ? (cur().turn === settings.humanSide && hist.length >= 3 ? 2 : 1)
    : 1;
  for (let i = 0; i < pops && hist.length > 1; i++) {
    hist.pop();
    logEntries.pop();
  }
  rebuildCaptured();
  result = null;
  selection = null;
  lastMove = null;
  $('ov-over').classList.add('hidden');
  $('btn-show-result').classList.add('hidden');
  newGame(false);
}

function rebuildCaptured() {
  capturedBy = { [BONE]: [], [ASH]: [] };
  for (let i = 1; i < hist.length; i++) {
    const prev = hist[i - 1], now = hist[i];
    // find a square that held an enemy piece in prev and holds the mover's piece now
    for (let s = 0; s < N * N; s++) {
      if (prev.board[s] !== EMPTY && Math.sign(prev.board[s]) === -prev.turn &&
          now.board[s] !== EMPTY && Math.sign(now.board[s]) === prev.turn) {
        capturedBy[prev.turn].push(Math.abs(prev.board[s]));
      }
    }
  }
}

function offerParley() {
  if (result || aiThinking) return;
  if (isOnline()) {
    if (!net?.connected) return;
    net.send({ t: 'parley-offer' });
    $('substatus').textContent = 'A parley is offered to the other court.';
    addChat('sys', 'You offer a parley.');
    return;
  }
  if (settings.mode === 'ai') {
    const aiSide = -settings.humanSide;
    // The Court accepts if it judges itself clearly worse.
    const v = quickEval(cur(), aiSide);
    setTimeout(() => {
      if (v < -180) {
        setResult({ type: 'parley' });
        paint(); save();
      } else {
        $('substatus').textContent = 'The Court declines your parley.';
      }
    }, 500);
  } else {
    const other = sideName(-cur().turn);
    confirmDialog('A Parley Is Offered', `${sideName(cur().turn)} offers a draw. Does ${other} accept?`, () => {
      setResult({ type: 'parley' });
      paint(); save();
    });
  }
}

function resign() {
  if (result || aiThinking) return;
  const loser = settings.mode === 'hotseat' ? cur().turn : settings.humanSide;
  confirmDialog('Resign the Board', `${sideName(loser)} yields the game. Are you certain?`, () => {
    if (isOnline()) net?.send({ t: 'resign' });
    setResult({ type: 'resign', loser });
    paint(); save();
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function save() {
  if (isOnline() || isTutorial()) return; // these sessions are not persisted
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      settings: { ...settings },
      hist: hist.map(serialize),
      logEntries,
      capturedBy: { [BONE]: capturedBy[BONE], [ASH]: capturedBy[ASH] },
      result: result ? { ...result, info: null } : null,
      flipped,
      lastMove,
      aiOpeningName: aiOpening ? aiOpening.name : null,
    }));
  } catch { /* storage unavailable — play on without saving */ }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* no storage */ }
}

function loadPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (o && PIECE_SETS[o.pieceSet]) prefs = { ...prefs, ...o };
  } catch { /* keep defaults */ }
}

const isMobileView = () => window.matchMedia('(max-width: 900px)').matches;
// Default: labels shown on desktop, hidden on mobile (for a larger board) — until
// the user makes an explicit choice in Options, which then holds on every device.
const showLabels = () => prefs.boardLabels ?? !isMobileView();

function applyBoardLabels() {
  document.body.classList.toggle('no-board-labels', !showLabels());
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o.hist || !o.hist.length) return false;
    settings = o.settings;
    if (settings.mode === 'online') settings.mode = 'hotseat'; // never restore a dead connection
    hist = o.hist.map(deserialize);
    logEntries = o.logEntries || [];
    capturedBy = { [BONE]: o.capturedBy?.[BONE] || [], [ASH]: o.capturedBy?.[ASH] || [] };
    result = o.result || null;
    flipped = !!o.flipped;
    lastMove = o.lastMove || null;
    aiOpening = OPENINGS.find((op) => op.name === o.aiOpeningName) || null;
    if (result && (result.type === 'isolation' || result.type === 'mutual' || result.type === 'palsy')) {
      // recompute the doom overlay from the final position
      const s = cur();
      const info = isolationInfo(s.board, s.turn, s.flucht[s.turn], true);
      if (info.isolated || result.type === 'palsy') result.info = info;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The Primer (tutorial)
// ---------------------------------------------------------------------------

function startTutorial() {
  leaveOnline();
  settings = { mode: 'tutorial', humanSide: BONE, level: 'courtier' };
  result = null;
  aiThinking = false;
  aiOpening = null;
  noticeText = null;
  flipped = false;
  tut = { step: -1, snaps: [] };
  $('ov-new').classList.add('hidden');
  $('ov-rules').classList.add('hidden');
  $('ov-over').classList.add('hidden');
  $('btn-show-result').classList.add('hidden');
  $('tutor-card').classList.remove('hidden');
  tutAdvance();
  layoutBoard();
  // On narrow layouts the sidebar sits below the board — bring the lesson into view.
  $('tutor-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tutAdvance() {
  tutGoto(tut.step + 1);
}

function tutBack() {
  if (tut.step > 0) tutGoto(tut.step - 1);
}

// Each lesson's entry position is snapshotted, so Back restores the board
// exactly as the lesson first found it — scripted moves then replay.
function tutSnapshot() {
  return {
    state: serialize(cur()),
    logEntries: logEntries.slice(),
    capturedBy: { [BONE]: capturedBy[BONE].slice(), [ASH]: capturedBy[ASH].slice() },
    lastMove: lastMove ? { ...lastMove } : null,
  };
}

function tutRestore(snap) {
  hist = [deserialize(snap.state)];
  logEntries = snap.logEntries.slice();
  capturedBy = { [BONE]: snap.capturedBy[BONE].slice(), [ASH]: snap.capturedBy[ASH].slice() };
  lastMove = snap.lastMove ? { ...snap.lastMove } : null;
  selection = null;
  legalCache = genLegal(cur());
  syncPieces();
}

function tutGoto(step) {
  if (step >= LESSONS.length) { exitTutorial(); return; }
  const back = step < tut.step;
  tut.step = step;
  tut.done = false;
  const s = LESSONS[step];
  noticeText = null;
  if (back && tut.snaps[step]) {
    tutRestore(tut.snaps[step]);
  } else if (s.setup) {
    hist = [buildTutState(s.setup)];
    logEntries = [];
    capturedBy = { [BONE]: [], [ASH]: [] };
    lastMove = null;
    selection = null;
    legalCache = genLegal(cur());
    syncPieces();
  }
  if (!back) tut.snaps[step] = tutSnapshot();
  if (s.escapes !== undefined) $('chk-escapes').checked = !!s.escapes;
  $('tutor-step').textContent = `${step + 1} of ${LESSONS.length}`;
  $('tutor-title').textContent = s.title;
  $('tutor-text').textContent = s.text;
  $('btn-tutor-back').classList.toggle('hidden', step === 0);
  const btn = $('btn-tutor-next');
  btn.classList.toggle('hidden', !!s.expect);
  btn.classList.remove('reveal');
  btn.textContent = step === LESSONS.length - 1 ? 'Finish' : 'Continue';
  paint();
  paintLog();
  // Scripted moves play out on the live board while the lesson narrates.
  if (s.autoMoves?.length) {
    const seq = s.autoMoves.slice();
    const playNext = () => {
      if (!tut || tut.step !== step) return; // the player has moved on
      const txt = seq.shift();
      const from = sqOf(txt.slice(0, txt.indexOf('-')));
      const to = sqOf(txt.slice(txt.indexOf('-') + 1));
      const m = legalCache.find((x) => x.from === from && x.to === to);
      if (m) playMove(m);
      if (seq.length) setTimeout(playNext, 850);
    };
    setTimeout(playNext, 700);
  }
}

function tutAllows(m) {
  const exp = LESSONS[tut.step]?.expect;
  if (!exp) return false;
  if (m.from !== sqOf(exp.from)) return false;
  return !exp.to || exp.to.some((name) => sqOf(name) === m.to);
}

// Gold sightline arrows for Primer lessons, drawn into the marks layer.
function paintTutArrows() {
  const marksEl = $('marks');
  let svg = marksEl.querySelector('svg.tut-arrows');
  const arrows = (tut && LESSONS[tut.step]?.arrows) || [];
  if (!arrows.length) { svg?.remove(); return; }
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'tut-arrows');
    svg.setAttribute('viewBox', '0 0 110 110');
    svg.setAttribute('preserveAspectRatio', 'none');
    marksEl.appendChild(svg);
  }
  svg.innerHTML = arrows.map(([f, t]) => {
    const A = sqToDisp(sqOf(f)), B = sqToDisp(sqOf(t));
    const ax = A.dc * 10 + 5, ay = A.dr * 10 + 5;
    let bx = B.dc * 10 + 5, by = B.dr * 10 + 5;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    bx -= ux * 3.4; by -= uy * 3.4;
    const head = 2.4;
    const hx = bx - ux * head, hy = by - uy * head;
    const px = -uy * head * 0.6, py = ux * head * 0.6;
    return `<g class="halo"><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/></g>` +
      `<line x1="${ax}" y1="${ay}" x2="${hx}" y2="${hy}"/>` +
      `<polygon points="${bx},${by} ${hx + px},${hy + py} ${hx - px},${hy - py}"/>`;
  }).join('');
}

function tutMarkSet() {
  const s = LESSONS[tut.step];
  const set = new Set();
  for (const name of s?.marks || []) set.add(sqOf(name));
  if (s?.expect) {
    set.add(sqOf(s.expect.from));
    for (const name of s.expect.to || []) set.add(sqOf(name));
  }
  return set;
}

function exitTutorial() {
  tut = null;
  $('tutor-card').classList.add('hidden');
  $('chk-escapes').checked = false;
  noticeText = null;
  // Return to whatever game was in progress before the Primer.
  if (!load()) {
    settings = { mode: 'hotseat', humanSide: BONE, level: 'courtier' };
    hist = [initialState()];
    logEntries = [];
    capturedBy = { [BONE]: [], [ASH]: [] };
    result = null;
    lastMove = null;
    flipped = false;
  }
  selection = null;
  layoutBoard();
  newGame(false);
  if (result) $('btn-show-result').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Chronicle export
// ---------------------------------------------------------------------------

function recordText() {
  const lines = ['Kronspiel — The Bone Court vs The Ash Court'];
  if (settings.mode === 'ai') {
    lines[0] += settings.humanSide === BONE
      ? ' (Bone: you · Ash: the Court)'
      : ' (Bone: the Court · Ash: you)';
  }
  lines.push('');
  const entryText = (e) => (e.text ? e.text : `${GLYPHS[e.piece]} ${e.body}`);
  for (let i = 0; i < logEntries.length; i += 2) {
    const n = `${i / 2 + 1}.`.padEnd(4);
    const bone = entryText(logEntries[i]).padEnd(16);
    const ash = logEntries[i + 1] ? entryText(logEntries[i + 1]) : '';
    lines.push((n + bone + ash).trimEnd());
  }
  if (result) {
    lines.push('');
    lines.push('Result: ' + result.label);
  }
  return lines.join('\n');
}

async function copyRecord() {
  if (!logEntries.length) {
    noticeText = 'The chronicle is still empty.';
    paintStatus();
    return;
  }
  try {
    await navigator.clipboard.writeText(recordText());
    noticeText = 'The chronicle is copied — paste it where you will.';
  } catch {
    noticeText = 'Copying failed — your browser withheld the clipboard.';
  }
  paintStatus();
}

// ---------------------------------------------------------------------------
// Annotation — arrows, highlights, labels and move-quality marks over the board,
// plus a copy-image-to-clipboard export. Pure overlay: it never touches game state.
// ---------------------------------------------------------------------------

const SVGNS = 'http://www.w3.org/2000/svg';

// Move-quality marks (chess NAGs). Each renders as a coloured corner badge.
const NAGS = {
  '!!': { fill: '#1aada6' }, // brilliant
  '!':  { fill: '#7aa64d' }, // good
  '!?': { fill: '#9a7fc0' }, // interesting
  '?!': { fill: '#d9963a' }, // dubious
  '?':  { fill: '#d97a34' }, // mistake
  '??': { fill: '#c33b2f' }, // blunder
};

let annotating = false;
let annoTool = 'arrow';   // 'arrow' | 'highlight' | 'text' | 'glyph'
let annoGlyph = '!!';     // active move-quality mark when annoTool === 'glyph'
let annoColor = '#e8c96a';
let anno = null;          // { arrows, highlights, glyphs, texts } — see clearAnno
let annoUnder = null;     // arrows + highlights, drawn BELOW the pieces
let annoOver = null;      // glyphs + labels + the interactive surface, ABOVE the pieces
let annoDrag = null;      // { fromSq, x, y } while dragging an arrow
let labelDrag = null;     // { i, offx, offy } while dragging a label
let annoInput = null;     // the inline label <input>, while one is open

function clearAnno() {
  anno = { arrows: [], highlights: [], glyphs: [], texts: [] };
  removeLabelInput();
  if (annoOver) renderAnno();
}

// Two overlays: arrows/highlights sit under the pieces so a piece never has an
// arrow tail drawn across it; glyphs/labels sit above, and carry the pointer
// interaction. Both share the board's 0..110 coordinate space.
function ensureAnnoLayer() {
  if (annoOver) return;
  annoUnder = document.createElementNS(SVGNS, 'svg');
  annoUnder.setAttribute('class', 'anno-layer anno-under');
  annoOver = document.createElementNS(SVGNS, 'svg');
  annoOver.setAttribute('class', 'anno-layer anno-over');
  for (const svg of [annoUnder, annoOver]) {
    svg.setAttribute('viewBox', '0 0 110 110');
    svg.setAttribute('preserveAspectRatio', 'none');
    boardEl.appendChild(svg);
  }
  annoOver.addEventListener('pointerdown', onAnnoDown);
  annoOver.addEventListener('pointermove', onAnnoMove);
  annoOver.addEventListener('pointerup', onAnnoUp);
  annoOver.addEventListener('pointerleave', () => { annoDrag = null; labelDrag = null; renderAnno(); });
}

// Board index / display-space point from a pointer event.
function annoPointAt(e) {
  const rect = boardEl.getBoundingClientRect();
  const x = clamp(((e.clientX - rect.left) / rect.width) * 110, 0, 110);
  const y = clamp(((e.clientY - rect.top) / rect.height) * 110, 0, 110);
  const dc = clamp(Math.floor(x / 10), 0, N - 1);
  const dr = clamp(Math.floor(y / 10), 0, N - 1);
  return { x, y, sq: dispToSq(dr, dc) };
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const capturePointer = (el, id) => { try { el.setPointerCapture?.(id); } catch {} };

function onAnnoDown(e) {
  if (!annotating) return;
  e.preventDefault();
  // Grabbing an existing label to move it takes precedence over any tool.
  const labelEl = e.target.closest?.('[data-label-i]');
  if (labelEl) {
    const i = +labelEl.dataset.labelI;
    const p = annoPointAt(e);
    labelDrag = { i, offx: anno.texts[i].x - p.x, offy: anno.texts[i].y - p.y };
    capturePointer(annoOver, e.pointerId);
    return;
  }
  capturePointer(annoOver, e.pointerId);
  const p = annoPointAt(e);
  if (annoTool === 'arrow') annoDrag = { fromSq: p.sq, x: p.x, y: p.y };
}

function onAnnoMove(e) {
  if (!annotating) return;
  if (labelDrag) {
    const p = annoPointAt(e);
    const t = anno.texts[labelDrag.i];
    t.x = clamp(p.x + labelDrag.offx, 0, 110);
    t.y = clamp(p.y + labelDrag.offy, 0, 110);
    renderAnno();
    return;
  }
  if (annoDrag) {
    const p = annoPointAt(e);
    annoDrag.x = p.x; annoDrag.y = p.y;
    renderAnno();
  }
}

function onAnnoUp(e) {
  if (!annotating) return;
  if (labelDrag) { labelDrag = null; renderAnno(); return; }
  const p = annoPointAt(e);
  if (annoTool === 'arrow') {
    if (annoDrag && annoDrag.fromSq !== p.sq) {
      anno.arrows.push({ from: annoDrag.fromSq, to: p.sq, color: annoColor });
    }
    annoDrag = null;
  } else if (annoTool === 'highlight') {
    const i = anno.highlights.findIndex((h) => h.sq === p.sq);
    if (i >= 0 && anno.highlights[i].color === annoColor) anno.highlights.splice(i, 1);
    else if (i >= 0) anno.highlights[i].color = annoColor;
    else anno.highlights.push({ sq: p.sq, color: annoColor });
  } else if (annoTool === 'glyph') {
    const i = anno.glyphs.findIndex((g) => g.sq === p.sq);
    if (i >= 0 && anno.glyphs[i].kind === annoGlyph) anno.glyphs.splice(i, 1);
    else if (i >= 0) anno.glyphs[i].kind = annoGlyph;
    else anno.glyphs.push({ sq: p.sq, kind: annoGlyph });
  } else if (annoTool === 'text') {
    openLabelInput(p.x, p.y);
    return; // the input commits the label
  }
  renderAnno();
}

// Inline, themed text entry — no system prompt. Enter commits, Escape cancels,
// clicking away commits whatever was typed.
function openLabelInput(x, y) {
  removeLabelInput();
  const inp = document.createElement('input');
  inp.className = 'anno-input';
  inp.type = 'text';
  inp.maxLength = 40;
  inp.style.left = (x / 110 * 100) + '%';
  inp.style.top = (y / 110 * 100) + '%';
  inp.style.setProperty('--ink', annoColor);
  let done = false; // Enter, Escape and blur can all fire — commit at most once
  const commit = () => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (v) anno.texts.push({ x, y, text: v, color: annoColor });
    removeLabelInput();
    renderAnno();
  };
  inp.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); done = true; removeLabelInput(); }
  });
  inp.addEventListener('blur', commit);
  boardEl.appendChild(inp);
  annoInput = inp;
  setTimeout(() => inp.focus(), 0);
}

function removeLabelInput() {
  const inp = annoInput;
  annoInput = null;
  if (inp && inp.parentNode) inp.parentNode.removeChild(inp);
}

// Arrows + highlights (+ the in-progress arrow), drawn beneath the pieces.
function annoUnderMarkup(includePreview) {
  const parts = [];
  for (const h of anno.highlights) {
    const { dr, dc } = sqToDisp(h.sq);
    parts.push(`<rect x="${dc * 10 + 0.6}" y="${dr * 10 + 0.6}" width="8.8" height="8.8" rx="1"
      fill="${h.color}" fill-opacity="0.3" stroke="${h.color}" stroke-opacity="0.85" stroke-width="0.7"/>`);
  }
  for (const a of anno.arrows) {
    const A = sqToDisp(a.from), B = sqToDisp(a.to);
    parts.push(arrowMarkup(A.dc * 10 + 5, A.dr * 10 + 5, B.dc * 10 + 5, B.dr * 10 + 5, a.color));
  }
  if (includePreview && annoDrag) {
    const A = sqToDisp(annoDrag.fromSq);
    parts.push(arrowMarkup(A.dc * 10 + 5, A.dr * 10 + 5, annoDrag.x, annoDrag.y, annoColor));
  }
  return parts.join('');
}

// Move-quality badges + draggable labels, drawn above the pieces. `interactive`
// adds the transparent catcher and the data hooks needed to grab labels.
function annoOverMarkup(interactive) {
  const parts = [];
  if (interactive) parts.push('<rect class="anno-catch" x="0" y="0" width="110" height="110" fill="transparent"/>');
  for (const g of anno.glyphs) {
    const { dr, dc } = sqToDisp(g.sq);
    const cx = dc * 10 + 8, cy = dr * 10 + 2.2, fill = (NAGS[g.kind] || {}).fill || '#c33b2f';
    parts.push(`<circle cx="${cx}" cy="${cy}" r="2.5" fill="${fill}" stroke="#0d0a07" stroke-width="0.4"/>`);
    parts.push(`<text class="anno-nag-text" x="${cx}" y="${cy + 0.15}" font-size="${g.kind.length > 1 ? 2.1 : 3}"
      text-anchor="middle" dominant-baseline="central">${g.kind}</text>`);
  }
  anno.texts.forEach((t, i) => {
    parts.push(`<text class="anno-label" ${interactive ? `data-label-i="${i}"` : ''} x="${t.x}" y="${t.y}" font-size="4"
      text-anchor="middle" dominant-baseline="central" fill="${t.color}">${escXml(t.text)}</text>`);
  });
  return parts.join('');
}

// A gold-halo arrow, matching the Primer's arrow geometry but caller-coloured.
function arrowMarkup(ax, ay, bx, by, color) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  bx -= ux * 3.2; by -= uy * 3.2;
  const head = 3.2;
  const hx = bx - ux * head, hy = by - uy * head;
  const px = -uy * head * 0.62, py = ux * head * 0.62;
  return `<g class="halo"><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke-width="3.2" stroke-linecap="round"/></g>` +
    `<line x1="${ax}" y1="${ay}" x2="${hx}" y2="${hy}" stroke="${color}" stroke-width="1.7" stroke-linecap="round"/>` +
    `<polygon points="${bx},${by} ${hx + px},${hy + py} ${hx - px},${hy - py}" fill="${color}"/>`;
}

function escXml(s) {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAnno() {
  if (!annoOver) return;
  annoUnder.innerHTML = annoUnderMarkup(true);
  annoOver.innerHTML = annoOverMarkup(true);
}

// On phones the tool panels dock at the bottom; frame the board when a mode opens.
function frameBoardOnMobile() {
  if (window.matchMedia('(max-width: 900px)').matches) {
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  }
}

function setAnnotating(on) {
  annotating = on;
  ensureAnnoLayer();
  if (on) frameBoardOnMobile();
  if (!on) removeLabelInput();
  $('annotate-bar').classList.toggle('hidden', !on);
  $('btn-annotate').classList.toggle('active', on);
  annoOver.classList.toggle('active', on);
  boardEl.classList.toggle('annotating', on);
  document.body.classList.toggle('annotating', on); // lets mobile dock the tools as a sheet
  if (on) { selection = null; if (viewing) replayRender(); else paint(); }
  renderAnno();
  if (on) openSheet('annotate');
  else if (openSheetName === 'annotate') closeSheet();
  refreshTabBar();
}

function selectAnnoTool(tool, glyph) {
  annoTool = tool;
  if (glyph) annoGlyph = glyph;
  for (const b of $('annotate-bar').querySelectorAll('.atool')) {
    b.classList.toggle('active',
      tool === 'glyph' ? (b.dataset.glyph === annoGlyph) : (b.dataset.tool === tool && !b.dataset.glyph));
  }
}

function annoUndo() {
  // No global ordering is kept, so undo peels marks off in a fixed priority:
  // freeform first (labels, then glyphs), then square fills, then arrows.
  const bucket = anno.texts.length ? anno.texts
    : anno.glyphs.length ? anno.glyphs
    : anno.highlights.length ? anno.highlights
    : anno.arrows;
  if (!bucket.length) return;
  bucket.pop();
  renderAnno();
}

// The position currently on the board — the replay step while viewing, else live.
function displayState() {
  return viewing && replay ? replay.states[replay.step] : cur();
}

// Render the whole board — squares, pieces, and annotations — into one SVG,
// then rasterise it to a PNG and copy it to the clipboard.
function buildBoardSvg() {
  const state = displayState();
  const cells = [];
  for (let disp = 0; disp < N * N; disp++) {
    const dr = Math.floor(disp / N), dc = disp % N;
    const sq = dispToSq(dr, dc);
    let fill = '#c7b89d';
    if (sq === ASCH) fill = '#17130f';
    else if ((rowOf(sq) + colOf(sq)) % 2 === 0) fill = '#514a40';
    cells.push(`<rect x="${dc * 10}" y="${dr * 10}" width="10" height="10" fill="${fill}"/>`);
    if (sq === ASCH) {
      cells.push(`<text x="${dc * 10 + 5}" y="${dr * 10 + 5.4}" font-size="5.2" text-anchor="middle"
        dominant-baseline="central" fill="rgba(200,162,74,0.32)">♛</text>`);
    }
  }

  const pieceParts = [];
  const useSigils = prefs.pieceSet === 'sigils';
  for (let sq = 0; sq < N * N; sq++) {
    const v = state.board[sq];
    if (v === EMPTY) continue;
    const { dr, dc } = sqToDisp(sq);
    const cls = v > 0 ? 'bone' : 'ash';
    if (useSigils) {
      pieceParts.push(`<g class="p ${cls}" transform="translate(${dc * 10 + 1} ${dr * 10 + 1}) scale(0.08)">${sigilInner(Math.abs(v))}</g>`);
    } else {
      const col = v > 0 ? '#f3ecdc' : '#211c17';
      pieceParts.push(`<text x="${dc * 10 + 5}" y="${dr * 10 + 5.4}" font-size="8" text-anchor="middle"
        dominant-baseline="central" fill="${col}" font-family="Georgia, serif">${GLYPHS[Math.abs(v)]}</text>`);
    }
  }

  return `<svg xmlns="${SVGNS}" width="792" height="792" viewBox="0 0 110 110">
    <style>
      .p { stroke-width: 3; stroke-linejoin: round; }
      .p.bone { fill: #f3ecdc; stroke: #453b2c; }
      .p.ash { fill: #211c17; stroke: rgba(243,236,220,0.6); }
      .p.bone .accent { fill: #453b2c; stroke: none; }
      .p.ash .accent { fill: #cbbfa8; stroke: none; }
      .halo { stroke: rgba(0,0,0,0.45); }
      .anno-label { font-family: Georgia, serif; font-weight: 600; paint-order: stroke; stroke: rgba(0,0,0,0.65); stroke-width: 0.7; stroke-linejoin: round; }
      .anno-nag-text { font-family: "Trebuchet MS", sans-serif; font-weight: 800; fill: #fff; }
    </style>
    <rect x="0" y="0" width="110" height="110" fill="#0d0a07"/>
    ${cells.join('')}
    ${annoUnderMarkup(false)}
    ${pieceParts.join('')}
    ${annoOverMarkup(false)}
  </svg>`;
}

async function copyAnnotatedImage() {
  const blob = await new Promise((resolve, reject) => {
    const svg = buildBoardSvg();
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 792; canvas.height = 792;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 792, 792);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/png');
    };
    img.onerror = () => reject(new Error('render'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });

  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    noticeText = 'The board is copied — paste the image where you will.';
  } catch {
    // Clipboard images aren't universally allowed; fall back to a download.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'kronspiel-board.png';
    a.click();
    URL.revokeObjectURL(url);
    noticeText = 'The clipboard was withheld — the board was saved as an image instead.';
  }
  paintStatus();
}

function initAnnotate() {
  clearAnno();
  $('btn-annotate').addEventListener('click', () => setAnnotating(!annotating));
  $('btn-anno-done').addEventListener('click', () => setAnnotating(false));
  $('btn-anno-undo').addEventListener('click', annoUndo);
  $('btn-anno-clear').addEventListener('click', clearAnno);
  $('btn-anno-copy').addEventListener('click', copyAnnotatedImage);
  for (const b of $('annotate-bar').querySelectorAll('.atool')) {
    b.addEventListener('click', () => selectAnnoTool(b.dataset.tool, b.dataset.glyph));
  }
  for (const b of $('annotate-bar').querySelectorAll('.aswatch')) {
    b.addEventListener('click', () => {
      annoColor = b.dataset.color;
      $('annotate-bar').querySelectorAll('.aswatch').forEach((s) => s.classList.toggle('active', s === b));
    });
  }
}

// ---------------------------------------------------------------------------
// Puzzle editor — a free-placement workbench. Build any position, then play it,
// share it as a code, or save it to a local library. Never runs the AI/online.
// ---------------------------------------------------------------------------

const PUZZLE_KEY = 'kronspiel-puzzles-v1';
const PIECE_TYPES = [KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER];

let editing = false;
let editState = null;                          // { board:Int8Array, turn, flucht }
let editBrush = { side: BONE, type: KRONE, erase: false };
let editDrag = null;                           // { fromSq, sx, sy, moved, val }
let editGhost = null;                          // the piece element riding the cursor mid-drag

function buildPalette(id, side) {
  const host = $(id);
  host.innerHTML = '';
  for (const type of PIECE_TYPES) {
    const b = document.createElement('button');
    b.className = `ed-pc-btn ed-brush ${side === BONE ? 'bone-piece' : 'ash-piece'}`;
    b.dataset.side = side;
    b.dataset.type = type;
    b.title = PIECE_NAMES_LOCAL[type];
    b.innerHTML = pieceHTML(prefs.pieceSet, type);
    host.appendChild(b);
  }
}
const PIECE_NAMES_LOCAL = {
  [KRONE]: 'Krone', [KANZLER]: 'Kanzler', [MARSCHALL]: 'Marschall',
  [PRALAT]: 'Prälat', [GESANDTER]: 'Gesandter', [BURGER]: 'Bürger',
};

function selectBrush(btn) {
  editBrush = btn.dataset.erase
    ? { erase: true }
    : { side: +btn.dataset.side, type: +btn.dataset.type, erase: false };
  for (const b of $('editor-bar').querySelectorAll('.ed-brush')) b.classList.toggle('active', b === btn);
}

function editSqFromEvent(e) {
  const rect = boardEl.getBoundingClientRect();
  const dc = clamp(Math.floor((e.clientX - rect.left) / (rect.width / N)), 0, N - 1);
  const dr = clamp(Math.floor((e.clientY - rect.top) / (rect.height / N)), 0, N - 1);
  return dispToSq(dr, dc);
}

function onEditDown(e) {
  if (!editing) return;
  if (!e.target.closest('.sq')) return;
  e.preventDefault();
  capturePointer(boardEl, e.pointerId);
  const fromSq = editSqFromEvent(e);
  editDrag = { fromSq, sx: e.clientX, sy: e.clientY, moved: false, val: editState.board[fromSq] };
}

function onEditMove(e) {
  if (!editing || !editDrag) return;
  if (!editDrag.moved && Math.hypot(e.clientX - editDrag.sx, e.clientY - editDrag.sy) > 6) {
    editDrag.moved = true;
    if (editDrag.val !== EMPTY) startEditGhost(editDrag.val, editDrag.fromSq); // lift the piece onto the cursor
  }
  if (editDrag.moved && editGhost) positionEditGhost(e.clientX, e.clientY);
}

function onEditUp(e) {
  if (!editing || !editDrag) return;
  removeEditGhost();
  const toSq = editSqFromEvent(e);
  const { fromSq, moved } = editDrag;
  editDrag = null;
  const b = editState.board;
  if (moved && fromSq !== toSq && b[fromSq] !== EMPTY) {
    if (toSq !== ASCH) { b[toSq] = b[fromSq]; b[fromSq] = EMPTY; } // relocate a piece
  } else if (toSq !== ASCH) {
    b[toSq] = editBrush.erase ? EMPTY : editBrush.type * editBrush.side; // stamp the brush
  }
  editRender();
}

// A piece that rides the cursor while dragging, so it clearly moves with you.
function startEditGhost(val, fromSq) {
  removeEditGhost();
  const size = boardEl.getBoundingClientRect().width / N;
  editGhost = document.createElement('div');
  editGhost.className = 'ed-ghost piece ' + (val > 0 ? 'bone-piece' : 'ash-piece');
  editGhost.style.width = size + 'px';
  editGhost.style.height = size + 'px';
  editGhost.innerHTML = pieceHTML(prefs.pieceSet, Math.abs(val));
  document.body.appendChild(editGhost);
  const src = pieceEls.get(fromSq); // dim the square it left
  if (src) src.style.opacity = '0.25';
}
function positionEditGhost(x, y) {
  editGhost.style.left = x + 'px';
  editGhost.style.top = y + 'px';
}
function removeEditGhost() {
  if (editGhost) { editGhost.remove(); editGhost = null; }
}

function editRender() {
  piecesEl.innerHTML = '';
  pieceEls = new Map();
  for (let i = 0; i < N * N; i++) {
    if (editState.board[i] !== EMPTY) pieceEls.set(i, makePieceEl(editState.board[i], i));
  }
  for (const el of squares) {
    const sq = +el.dataset.sq;
    el.className = 'sq ' + (sq === ASCH ? 'asch' : (rowOf(sq) + colOf(sq)) % 2 === 1 ? 'bone' : 'ash');
  }
  editValidate();
}

function editValidate() {
  const b = editState.board;
  let bk = 0, ak = 0;
  for (let i = 0; i < N * N; i++) {
    if (b[i] === KRONE * BONE) bk++;
    else if (b[i] === KRONE * ASH) ak++;
  }
  const ok = bk === 1 && ak === 1;
  const st = $('ed-status');
  if (ok) {
    st.textContent = 'A valid position — ready to play.';
    st.className = 'ed-status ok';
  } else {
    const parts = [];
    if (bk !== 1) parts.push(`Bone needs one Krone (has ${bk})`);
    if (ak !== 1) parts.push(`Ash needs one Krone (has ${ak})`);
    st.textContent = parts.join(' · ');
    st.className = 'ed-status warn';
  }
  $('btn-ed-play').disabled = !ok;
  return ok;
}

function syncEditControls() {
  $('ed-turn').querySelectorAll('.seg-btn').forEach((btn) =>
    btn.classList.toggle('active', (btn.dataset.v === 'ash') === (editState.turn === ASH)));
  $('ed-flucht-bone').checked = !!editState.flucht[BONE];
  $('ed-flucht-ash').checked = !!editState.flucht[ASH];
}

function enterEditor(fromCurrent) {
  if (isOnline()) { noticeText = 'Leave the online table before opening the editor.'; paintStatus(); return; }
  if (viewing) leaveViewingUi();
  setAnnotating(false);
  editing = true;
  editState = {
    board: fromCurrent ? new Int8Array(cur().board) : new Int8Array(N * N),
    turn: fromCurrent ? cur().turn : BONE,
    flucht: fromCurrent
      ? { [BONE]: cur().flucht[BONE], [ASH]: cur().flucht[ASH] }
      : { [BONE]: true, [ASH]: true },
  };
  document.body.classList.add('editing');
  $('editor-bar').classList.remove('hidden');
  $('btn-puzzle').classList.add('active');
  selection = null;
  syncEditControls();
  editRender();
  frameBoardOnMobile();
  openSheet('editor');
}

function exitEditorUi() {
  editing = false;
  editDrag = null;
  document.body.classList.remove('editing');
  $('editor-bar').classList.add('hidden');
  $('btn-puzzle').classList.remove('active');
  closeSheet();
}

function exitEditor() {
  exitEditorUi();
  syncPieces(); // restore the real game's pieces and board
  paint();
}

function playFromHere() {
  if (!editValidate()) return;
  leaveTutorial();
  settings = { mode: 'hotseat', humanSide: BONE, level: 'courtier' };
  const s = {
    board: new Int8Array(editState.board),
    turn: editState.turn,
    flucht: { [BONE]: editState.flucht[BONE], [ASH]: editState.flucht[ASH] },
    clock: 0,
    reps: {},
    ply: 0,
  };
  s.reps[positionKey(s)] = 1;
  hist = [s];
  logEntries = [];
  capturedBy = { [BONE]: [], [ASH]: [] };
  result = null;
  lastMove = null;
  selection = null;
  aiThinking = false;
  noticeText = null;
  aiOpening = null;
  exitEditorUi();
  $('ov-over').classList.add('hidden');
  $('btn-show-result').classList.add('hidden');
  syncPieces();
  afterPositionChange(); // runs genLegal, checks for an already-decided position, paints, saves
}

// Shareable positions ---------------------------------------------------------
const puzzlePayload = () => ({ b: Array.from(editState.board), t: editState.turn, f: [editState.flucht[BONE] ? 1 : 0, editState.flucht[ASH] ? 1 : 0] });
function editCode() { return 'KP1:' + b64enc(JSON.stringify(puzzlePayload())); } // for the local library

// A tappable link; pass a stored KP1 code, or omit to share the current position.
function puzzleShareUrl(kp1) {
  const json = kp1 ? b64dec(kp1.replace(/^KP1:/i, '')) : JSON.stringify(puzzlePayload());
  return shareLink('p', urlEnc(json));
}

// Accepts a share link (?p=…), a KP1 code, or a raw payload.
function applyCode(input) {
  input = String(input).trim();
  let json;
  if (/[?&#]p=/.test(input)) json = urlDec(extractParam(input, 'p'));
  else if (/^KP1:/i.test(input)) json = b64dec(input.replace(/^KP1:/i, ''));
  else { try { json = urlDec(input); } catch { json = b64dec(input); } }
  const o = JSON.parse(json);
  if (!Array.isArray(o.b) || o.b.length !== N * N) throw new Error('bad');
  editState.board = Int8Array.from(o.b.map((v) => v | 0));
  editState.turn = o.t === -1 ? ASH : BONE;
  editState.flucht = { [BONE]: !!(o.f && o.f[0]), [ASH]: !!(o.f && o.f[1]) };
  syncEditControls();
  editRender();
}

// Local library --------------------------------------------------------------
function getPuzzles() {
  try { return JSON.parse(localStorage.getItem(PUZZLE_KEY)) || []; } catch { return []; }
}
function setPuzzles(list) {
  try { localStorage.setItem(PUZZLE_KEY, JSON.stringify(list)); } catch {}
}
function initEditor() {
  buildPalette('palette-bone', BONE);
  buildPalette('palette-ash', ASH);

  boardEl.addEventListener('pointerdown', onEditDown);
  boardEl.addEventListener('pointermove', onEditMove);
  boardEl.addEventListener('pointerup', onEditUp);

  $('btn-puzzle').addEventListener('click', () => (editing ? exitEditor() : enterEditor(true)));
  $('btn-ed-done').addEventListener('click', exitEditor);
  $('btn-ed-play').addEventListener('click', playFromHere);

  for (const b of $('editor-bar').querySelectorAll('.ed-brush')) {
    b.addEventListener('click', () => selectBrush(b));
  }
  // Default brush: the Bone Krone (a natural first placement).
  selectBrush($('palette-bone').querySelector('.ed-pc-btn'));

  for (const btn of $('ed-turn').querySelectorAll('.seg-btn')) {
    btn.addEventListener('click', () => {
      editState.turn = btn.dataset.v === 'ash' ? ASH : BONE;
      syncEditControls();
    });
  }
  $('ed-flucht-bone').addEventListener('change', (e) => { editState.flucht[BONE] = e.target.checked; });
  $('ed-flucht-ash').addEventListener('change', (e) => { editState.flucht[ASH] = e.target.checked; });

  $('btn-ed-start').addEventListener('click', () => {
    const init = initialState();
    editState.board = new Int8Array(init.board);
    editState.turn = BONE;
    editState.flucht = { [BONE]: true, [ASH]: true };
    syncEditControls();
    editRender();
  });
  $('btn-ed-clear').addEventListener('click', () => {
    editState.board = new Int8Array(N * N);
    editRender();
  });

  $('btn-ed-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(puzzleShareUrl()); editStatusFlash('Share link copied to the clipboard.'); }
    catch { editStatusFlash('Copying failed — the browser withheld the clipboard.'); }
  });
  $('btn-ed-save').addEventListener('click', async () => {
    const name = await promptDialog({
      title: 'Save to the Library',
      note: 'Name this puzzle so you can find it later.',
      placeholder: 'e.g. The Fool’s Gate',
      ok: 'Save',
    });
    if (!name) return;
    const list = getPuzzles();
    list.push({ name, code: editCode() });
    setPuzzles(list);
    editStatusFlash('Saved to your puzzle library.');
  });
  $('btn-ed-library').addEventListener('click', () => { renderPuzzles(); $('ov-puzzles').classList.remove('hidden'); });

  // Puzzle library modal
  $('btn-puzzles-close').addEventListener('click', () => $('ov-puzzles').classList.add('hidden'));
  $('ov-puzzles').addEventListener('click', (e) => { if (e.target === $('ov-puzzles')) $('ov-puzzles').classList.add('hidden'); });
  $('btn-puzzles-load').addEventListener('click', async () => {
    const code = await promptDialog({ title: 'Load a Shared Puzzle', note: 'Paste a Kronspiel puzzle link.', placeholder: 'https://…?p=…', ok: 'Load' });
    if (!code) return;
    if (!editing) enterEditor(false);
    try { applyCode(code); $('ov-puzzles').classList.add('hidden'); } catch { editStatusFlash('That link could not be read.'); }
  });
  $('puzzles-list').addEventListener('click', (e) => {
    const open = e.target.closest('.annals-open');
    const copy = e.target.closest('.annals-copy');
    const del = e.target.closest('.annals-del');
    if (open) {
      const pz = getPuzzles()[+open.dataset.i];
      if (pz) {
        if (!editing) enterEditor(false);
        try { applyCode(pz.code); $('ov-puzzles').classList.add('hidden'); } catch { editStatusFlash('That saved puzzle could not be read.'); }
      }
    } else if (copy) {
      const pz = getPuzzles()[+copy.dataset.i];
      if (pz) navigator.clipboard?.writeText(puzzleShareUrl(pz.code)).then(() => flashButton(copy, '✓'), () => {});
    } else if (del) {
      const list = getPuzzles();
      list.splice(+del.dataset.i, 1);
      setPuzzles(list);
      renderPuzzles();
    }
  });
}

function renderPuzzles() {
  const list = getPuzzles();
  const el = $('puzzles-list');
  if (!list.length) { el.innerHTML = '<div class="annals-empty">No saved puzzles yet. Build a position and press Save.</div>'; return; }
  el.innerHTML = list.map((pz, i) =>
    `<div class="annals-row">
      <button class="annals-open" data-i="${i}"><span class="an-name">${escXml(pz.name)}</span><span class="an-sub">Open in the editor</span></button>
      <button class="annals-copy" data-i="${i}" title="Copy a share link">⧉</button>
      <button class="annals-del" data-i="${i}" title="Delete">✕</button>
    </div>`).join('');
}

// A transient message shown in the editor's status line (restores validation next render).
function editStatusFlash(msg) {
  const st = $('ed-status');
  st.textContent = msg;
  st.className = 'ed-status';
  setTimeout(() => { if (editing) editValidate(); }, 2200);
}

// ---------------------------------------------------------------------------
// The Annals — save finished games, then walk through them move by move and
// annotate each position. A saved game keeps every serialized state, so replay
// is a matter of stepping an index; per-ply annotations ride alongside.
// ---------------------------------------------------------------------------

const ANNALS_KEY = 'kronspiel-annals-v1';
const ANNALS_MAX = 100;
const EMPTY_ANNO = () => ({ arrows: [], highlights: [], glyphs: [], texts: [] });

let viewing = false;
let replay = null;        // { name, states, moves, log, notes, step, entryTs }
let replayTimer = null;

function getAnnals() {
  try { return JSON.parse(localStorage.getItem(ANNALS_KEY)) || []; } catch { return []; }
}
function setAnnals(list) {
  try { localStorage.setItem(ANNALS_KEY, JSON.stringify(list)); } catch {}
}

// Reconstruct each move's {from,to} by diffing consecutive states — enough to
// highlight the move on the board without storing moves separately.
function movesFromHist(states) {
  const moves = [];
  for (let k = 1; k < states.length; k++) {
    const s = states[k - 1], t = states[k], side = s.turn;
    let from = -1, to = -1;
    for (let i = 0; i < N * N; i++) {
      const before = Math.sign(s.board[i]) === side;
      const after = Math.sign(t.board[i]) === side;
      if (before && !after) from = i;
      if (!before && after) to = i;
    }
    moves.push({ from, to });
  }
  return moves;
}

// Keep only the plies that actually carry annotations, so storage stays lean.
function prunedNotes(notes) {
  const out = {};
  for (const [k, v] of Object.entries(notes)) {
    if (v && (v.arrows.length || v.highlights.length || v.glyphs.length || v.texts.length)) out[k] = v;
  }
  return out;
}

function renderAnnals() {
  const list = getAnnals();
  const el = $('annals-list');
  if (!list.length) { el.innerHTML = '<div class="annals-empty">The annals are empty. Finish a game and save it here.</div>'; return; }
  el.innerHTML = list.map((g, i) => {
    const when = new Date(g.ts).toLocaleString();
    const plies = Math.max(0, (g.hist?.length || 1) - 1);
    return `<div class="annals-row">
      <button class="annals-open" data-i="${i}">
        <span class="an-name">${escXml(g.name)}</span>
        <span class="an-sub">${escXml(g.resultLabel)} · ${plies} plies · ${escXml(when)}</span>
      </button>
      <button class="annals-copy" data-i="${i}" title="Copy a share link">⧉</button>
      <button class="annals-del" data-i="${i}" title="Delete">✕</button>
    </div>`;
  }).join('');
}

// A shareable replay link straight from a stored annals entry.
function annalsShareUrl(g) {
  return shareLink('g', replayShareCode({
    name: g.name, mode: g.mode, resultLabel: g.resultLabel,
    states: (g.hist || []).map(deserialize), notes: g.notes, commentary: g.commentary,
  }));
}

// ---- The replay viewer ----
// One machine serves two sources: a saved annals entry, or the game that just
// finished (source 'live', not yet saved). Either can be annotated and saved.

function startReplay(cfg) {
  stopAutoplay();
  if (editing) exitEditorUi();
  setAnnotating(false);
  viewing = true;
  replay = {
    postGame: !!cfg.postGame,      // the game that just ended (offers New Game)
    entryTs: cfg.entryTs || null,  // annals key once saved; null until then
    name: cfg.name,
    mode: cfg.mode,
    resultLabel: cfg.resultLabel,
    states: cfg.states,
    moves: movesFromHist(cfg.states),
    log: cfg.log || [],
    notes: cfg.notes ? JSON.parse(JSON.stringify(cfg.notes)) : {},
    commentary: cfg.commentary ? { ...cfg.commentary } : {},
    step: cfg.startAtEnd ? cfg.states.length - 1 : 0,
  };
  document.body.classList.add('viewing');
  $('replay-bar').classList.remove('hidden');
  $('btn-show-result').classList.add('hidden');
  $('replay-name').textContent = cfg.resultLabel || '';
  $('replay-name-input').value = cfg.name || '';
  $('btn-rp-newgame').classList.toggle('hidden', !replay.postGame);
  refreshSaveButton();
  selection = null;
  loadStepAnno(replay.step);
  loadCommentary(replay.step);
  replayRender();
  frameBoardOnMobile();
  openSheet('replay');
}

function openReplayFromEntry(entry) {
  startReplay({
    entryTs: entry.ts,
    name: entry.name,
    mode: entry.mode,
    resultLabel: entry.resultLabel,
    states: entry.hist.map(deserialize),
    log: entry.log,
    notes: entry.notes,
    commentary: entry.commentary,
  });
}

// Review the game that just ended — no save required to walk or annotate it.
function openPostGameReview() {
  $('ov-over').classList.add('hidden');
  startReplay({
    postGame: true,
    name: (result?.title || 'A Game') + ' · ' + new Date().toLocaleDateString(),
    mode: settings.mode,
    resultLabel: result ? result.label : 'Unfinished',
    states: hist.map((s) => deserialize(serialize(s))), // detached copies
    log: logEntries.slice(),
    startAtEnd: true,
  });
}

function refreshSaveButton() {
  $('btn-rp-save').textContent = replay.entryTs ? 'Update the Annals' : 'Save to the Annals';
}

function leaveViewingUi() {
  stopAutoplay();
  setAnnotating(false);
  viewing = false;
  replay = null;
  document.body.classList.remove('viewing');
  $('replay-bar').classList.add('hidden');
  clearAnno();
  closeSheet();
}

function exitReplay() {
  const wasPostGame = replay?.postGame;
  leaveViewingUi();
  syncPieces();
  paint();
  if (wasPostGame && result) $('btn-show-result').classList.remove('hidden');
}

function stashStepAnno() {
  if (replay) replay.notes[replay.step] = JSON.parse(JSON.stringify(anno));
}
function loadStepAnno(step) {
  removeLabelInput();
  anno = replay.notes[step] ? JSON.parse(JSON.stringify(replay.notes[step])) : EMPTY_ANNO();
}
function stashCommentary() {
  if (replay) replay.commentary[replay.step] = $('replay-commentary').value;
}
function loadCommentary(step) {
  $('replay-commentary').value = replay.commentary[step] || '';
}

function replayGoto(step) {
  const total = replay.states.length - 1;
  step = clamp(step, 0, total);
  if (step === replay.step) return;
  stashStepAnno();
  stashCommentary();
  const old = replay.step;
  replay.step = step;
  loadStepAnno(step);
  loadCommentary(step);
  // A single move slides the way live play does; larger jumps rebuild instantly.
  if (Math.abs(step - old) !== 1 || !animateReplayStep(old, step)) rebuildReplayPieces();
  paintReplayChrome();
  renderAnno();
}

function rebuildReplayPieces() {
  const st = replay.states[replay.step];
  piecesEl.innerHTML = '';
  pieceEls = new Map();
  for (let i = 0; i < N * N; i++) {
    if (st.board[i] !== EMPTY) pieceEls.set(i, makePieceEl(st.board[i], i));
  }
}

// Slide the one piece that moved between adjacent steps, reusing its element so
// the CSS transform transition animates it. Returns false to fall back to rebuild.
function animateReplayStep(oldStep, newStep) {
  const forward = newStep === oldStep + 1;
  const m = forward ? replay.moves[oldStep] : replay.moves[newStep];
  if (!m || m.from < 0 || m.to < 0) return false;
  const after = replay.states[newStep];
  const from = forward ? m.from : m.to; // where the mover currently sits
  const to = forward ? m.to : m.from;   // where it lands
  const el = pieceEls.get(from);
  if (!el) return false;
  const occ = pieceEls.get(to); // a captured piece (forward only)
  if (occ) { occ.classList.add('captured-anim'); setTimeout(() => occ.remove(), 260); pieceEls.delete(to); }
  el.classList.add('moving');
  placePiece(el, to);
  pieceEls.delete(from);
  pieceEls.set(to, el);
  setTimeout(() => {
    if (pieceEls.get(to) !== el) return; // a later step overtook this one
    el.classList.remove('moving');
    if (after.board[to] !== EMPTY) el.innerHTML = pieceHTML(prefs.pieceSet, Math.abs(after.board[to]));
  }, 230);
  // Rewinding a capture: the taken piece returns to its square.
  if (!forward && after.board[m.to] !== EMPTY) pieceEls.set(m.to, makePieceEl(after.board[m.to], m.to));
  return true;
}

function paintReplayChrome() {
  const lm = replay.step > 0 ? replay.moves[replay.step - 1] : null;
  for (const el of squares) {
    const sq = +el.dataset.sq;
    let cls = 'sq ' + (sq === ASCH ? 'asch' : (rowOf(sq) + colOf(sq)) % 2 === 1 ? 'bone' : 'ash');
    if (lm && sq === lm.from) cls += ' last-from';
    if (lm && sq === lm.to) cls += ' last-to';
    el.className = cls;
  }
  const total = replay.states.length - 1;
  $('replay-count').textContent = `Move ${replay.step} of ${total}`;
  const move = $('replay-move');
  if (replay.step === 0) {
    move.innerHTML = '<span class="dim">Starting position</span>';
  } else {
    const entry = replay.log[replay.step - 1];
    const num = Math.floor((replay.step - 1) / 2) + 1;
    move.innerHTML = '';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = num + (entry && entry.side === BONE ? '. ' : '… ');
    move.append(n, entry ? logSpan(entry, entry.side === BONE ? 'bone-piece' : 'ash-piece') : document.createTextNode('—'));
  }
}

function replayRender() {
  rebuildReplayPieces();
  paintReplayChrome();
  renderAnno();
}

function stopAutoplay() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  $('btn-rp-play').classList.remove('playing');
  $('btn-rp-play').textContent = '▶';
}
function toggleAutoplay() {
  if (replayTimer) { stopAutoplay(); return; }
  if (replay.step >= replay.states.length - 1) replayGoto(0);
  $('btn-rp-play').classList.add('playing');
  $('btn-rp-play').textContent = '❚❚';
  replayTimer = setInterval(() => {
    if (replay.step >= replay.states.length - 1) { stopAutoplay(); return; }
    replayGoto(replay.step + 1);
  }, 950);
}

function prunedCommentary(commentary) {
  const out = {};
  for (const [k, v] of Object.entries(commentary)) if (v && v.trim()) out[k] = v;
  return out;
}
const replayName = () => $('replay-name-input').value.trim() || replay.name || 'A Game';

// Save (or update) the game being reviewed — with its per-ply annotations and prose.
function saveReplay() {
  stashStepAnno();
  stashCommentary();
  const list = getAnnals();
  const payload = {
    name: replayName(),
    mode: replay.mode,
    resultLabel: replay.resultLabel,
    hist: replay.states.map(serialize),
    log: replay.log,
    notes: prunedNotes(replay.notes),
    commentary: prunedCommentary(replay.commentary),
  };
  let entry = replay.entryTs ? list.find((x) => x.ts === replay.entryTs) : null;
  if (entry) {
    Object.assign(entry, payload);
  } else {
    entry = { ts: Date.now(), ...payload };
    list.unshift(entry);
    if (list.length > ANNALS_MAX) list.length = ANNALS_MAX;
    replay.entryTs = entry.ts;
    replay.postGame = false; // it now lives in the annals
    $('btn-rp-newgame').classList.add('hidden');
  }
  setAnnals(list);
  refreshSaveButton();
  flashButton($('btn-rp-save'), 'Saved ✓');
}

// UTF-8-safe base64 (move notation and prose carry non-Latin1 glyphs).
// UTF-8 base64, plus a URL-safe variant (move notation and prose carry non-Latin1 glyphs).
const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
const b64dec = (s) => decodeURIComponent(escape(atob(s)));
const urlEnc = (s) => b64enc(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const urlDec = (s) => b64dec(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));

// Pull a query value out of a pasted link, or return the trimmed input unchanged.
function extractParam(input, key) {
  input = String(input).trim();
  const m = input.match(new RegExp('[?&#]' + key + '=([^&\\s]+)'));
  return m ? decodeURIComponent(m[1]) : input;
}
// A tappable link to the game carrying a shared code — nicer in a messenger than a raw blob.
function shareLink(key, code) {
  let base = location.origin + location.pathname;
  base = /play\.html$/.test(base) ? base : base.replace(/[^/]*$/, 'play.html');
  return `${base}?${key}=${code}`;
}

// A replay code stores only the start position and the list of moves (plus notes and
// prose) and rebuilds the board history on load — a fraction of the size of every state.
function replayShareCode(src) {
  const start = src.states[0];
  return urlEnc(JSON.stringify({
    v: 2, n: src.name, m: src.mode, r: src.resultLabel,
    s: { b: Array.from(start.board), t: start.turn, f: [start.flucht[BONE] ? 1 : 0, start.flucht[ASH] ? 1 : 0] },
    mv: movesFromHist(src.states).map((m) => [m.from, m.to]),
    no: prunedNotes(src.notes || {}),
    co: prunedCommentary(src.commentary || {}),
  }));
}

function replayFromShareCode(input) {
  const o = JSON.parse(urlDec(extractParam(input, 'g')));
  if (o.h) { // legacy full-history format
    return { name: o.n, mode: o.m, resultLabel: o.r, states: o.h.map(deserialize), log: o.l || [], notes: o.no || {}, commentary: o.co || {} };
  }
  const start = {
    board: Int8Array.from(o.s.b.map((v) => v | 0)),
    turn: o.s.t === -1 ? ASH : BONE,
    flucht: { [BONE]: !!o.s.f[0], [ASH]: !!o.s.f[1] },
    clock: 0, reps: {}, ply: 0,
  };
  start.reps[positionKey(start)] = 1;
  const states = [start], log = [];
  for (const [from, to] of (o.mv || [])) {
    const before = states[states.length - 1];
    const m = genLegal(before).find((x) => x.from === from && x.to === to);
    if (!m) break; // stop at the first move the current rules reject
    log.push({ ply: before.ply, side: before.turn, piece: Math.abs(before.board[from]), body: notateBody(before, m) });
    states.push(apply(before, m));
  }
  return { name: o.n, mode: o.m, resultLabel: o.r, states, log, notes: o.no || {}, commentary: o.co || {} };
}

function shareReplay() {
  stashStepAnno();
  stashCommentary();
  const url = shareLink('g', replayShareCode({
    name: replayName(), mode: replay.mode, resultLabel: replay.resultLabel,
    states: replay.states, notes: replay.notes, commentary: replay.commentary,
  }));
  navigator.clipboard?.writeText(url).then(
    () => flashButton($('btn-rp-share'), 'Link copied ✓'),
    () => promptDialog({ title: 'Share this Replay', note: 'Copy this link and send it along.', value: url, ok: 'Done' }),
  );
}

async function loadSharedReplay() {
  const code = await promptDialog({ title: 'Load a Shared Replay', note: 'Paste a Kronspiel replay link.', placeholder: 'https://…?g=…', ok: 'Load' });
  if (!code) return;
  try {
    const cfg = replayFromShareCode(code);
    if (!cfg.states.length) throw new Error('bad');
    $('ov-annals').classList.add('hidden');
    startReplay(cfg);
  } catch {
    renderAnnals();
    $('annals-list').insertAdjacentHTML('afterbegin', '<div class="annals-empty">That replay link could not be read.</div>');
  }
}

function flashButton(btn, msg) {
  const was = btn.textContent;
  btn.textContent = msg;
  setTimeout(() => { if (btn.textContent === msg) btn.textContent = was; }, 1600);
}

function initAnnals() {
  $('btn-annals').addEventListener('click', () => { renderAnnals(); $('ov-annals').classList.remove('hidden'); });
  $('btn-annals-close').addEventListener('click', () => $('ov-annals').classList.add('hidden'));
  $('ov-annals').addEventListener('click', (e) => { if (e.target === $('ov-annals')) $('ov-annals').classList.add('hidden'); });
  $('btn-annals-load').addEventListener('click', loadSharedReplay);
  $('btn-over-review').addEventListener('click', openPostGameReview);

  $('annals-list').addEventListener('click', (e) => {
    const open = e.target.closest('.annals-open');
    const copy = e.target.closest('.annals-copy');
    const del = e.target.closest('.annals-del');
    if (open) {
      const entry = getAnnals()[+open.dataset.i];
      if (entry) { $('ov-annals').classList.add('hidden'); openReplayFromEntry(entry); }
    } else if (copy) {
      const g = getAnnals()[+copy.dataset.i];
      if (g) navigator.clipboard?.writeText(annalsShareUrl(g)).then(() => flashButton(copy, '✓'), () => {});
    } else if (del) {
      const list = getAnnals();
      list.splice(+del.dataset.i, 1);
      setAnnals(list);
      renderAnnals();
    }
  });

  $('btn-rp-first').addEventListener('click', () => { stopAutoplay(); replayGoto(0); });
  $('btn-rp-prev').addEventListener('click', () => { stopAutoplay(); replayGoto(replay.step - 1); });
  $('btn-rp-next').addEventListener('click', () => { stopAutoplay(); replayGoto(replay.step + 1); });
  $('btn-rp-last').addEventListener('click', () => { stopAutoplay(); replayGoto(replay.states.length - 1); });
  $('btn-rp-play').addEventListener('click', toggleAutoplay);
  $('btn-rp-annotate').addEventListener('click', () => setAnnotating(!annotating));
  $('btn-rp-save').addEventListener('click', saveReplay);
  $('btn-rp-share').addEventListener('click', shareReplay);
  $('btn-rp-newgame').addEventListener('click', () => { exitReplay(); $('btn-show-result').classList.add('hidden'); $('ov-new').classList.remove('hidden'); });
  $('btn-rp-exit').addEventListener('click', exitReplay);
  $('replay-commentary').addEventListener('input', stashCommentary);

  document.addEventListener('keydown', (e) => {
    if (!viewing || annoInput) return;
    if (e.target === $('replay-commentary') || e.target === $('replay-name-input')) return; // typing
    if (e.key === 'ArrowLeft') { stopAutoplay(); replayGoto(replay.step - 1); }
    else if (e.key === 'ArrowRight') { stopAutoplay(); replayGoto(replay.step + 1); }
  });
}

// ---------------------------------------------------------------------------
// Mobile app shell — a persistent bottom tab bar and pull-up sheets. The board
// stays fixed in one spot; controls, the Chronicle, the Parlour, and the
// editor / annotate / replay modes are all sheets. Inert on desktop.
// ---------------------------------------------------------------------------

const SHEET_IDS = {
  controls: 'sheet-controls', chronicle: 'sheet-chronicle', chat: 'chat-card',
  annotate: 'annotate-bar', editor: 'editor-bar', replay: 'replay-bar',
};
let openSheetName = null;

// The tabs offered depend on context: a live game, the editor, or a replay.
function mobileTabs() {
  if (editing) return [['editor', '✦', 'Editor']];
  if (viewing) return [['replay', '⏵', 'Replay'], ['annotate', '✎', 'Draw']];
  const tabs = [['controls', '⚔', 'Controls'], ['chronicle', '❦', 'Chronicle']];
  if (isOnline()) tabs.push(['chat', '✉', 'Parlour']);
  tabs.push(['annotate', '✎', 'Draw']);
  return tabs;
}

function refreshTabBar() {
  const bar = $('mobile-tabs');
  if (!bar) return;
  bar.innerHTML = mobileTabs().map(([name, ico, label]) =>
    `<button class="mtab${openSheetName === name ? ' active' : ''}" data-sheet="${name}">` +
    `<span class="mt-ico" aria-hidden="true">${ico}</span>${label}</button>`).join('');
}

function openSheet(name) {
  if (openSheetName && openSheetName !== name) $(SHEET_IDS[openSheetName])?.classList.remove('m-open');
  $(SHEET_IDS[name])?.classList.add('m-open');
  openSheetName = name;
  refreshTabBar();
}
function closeSheet(name) {
  if (name && openSheetName !== name) return; // only close the named one
  if (openSheetName) $(SHEET_IDS[openSheetName])?.classList.remove('m-open');
  openSheetName = null;
  refreshTabBar();
}
function toggleSheet(name) { openSheetName === name ? closeSheet() : openSheet(name); }

function initMobileShell() {
  $('mobile-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.mtab');
    if (!b) return;
    const name = b.dataset.sheet;
    if (name === 'annotate' && !annotating) { setAnnotating(true); return; } // enters mode, which opens the sheet
    toggleSheet(name);
  });
  window.matchMedia('(max-width: 900px)').addEventListener?.('change', () => { closeSheet(); applyBoardLabels(); });

  // The ☰ top-bar menu just fires the real (desktop) nav buttons.
  $('btn-menu').addEventListener('click', () => $('ov-menu').classList.remove('hidden'));
  $('btn-menu-close').addEventListener('click', () => $('ov-menu').classList.add('hidden'));
  $('ov-menu').addEventListener('click', (e) => {
    if (e.target === $('ov-menu')) { $('ov-menu').classList.add('hidden'); return; }
    const b = e.target.closest('[data-menu]');
    if (b) { $('ov-menu').classList.add('hidden'); $(b.dataset.menu).click(); }
  });

  refreshTabBar();
}

// ---------------------------------------------------------------------------
// Online play
// ---------------------------------------------------------------------------

let chatUnread = 0;

function showChat(on) {
  $('chat-card').classList.toggle('hidden', !on);
  $('btn-focus-chat').classList.toggle('unavailable', !on);
  if (!on) {
    document.body.classList.remove('chat-open');
    chatUnread = 0;
    paintChatUnread();
    if (openSheetName === 'chat') closeSheet();
  }
  refreshTabBar(); // the Parlour tab appears/vanishes with the online table
}

function paintChatUnread() {
  const el = $('chat-unread');
  el.classList.toggle('hidden', chatUnread === 0);
  el.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
}

function toggleFocusChat() {
  const open = document.body.classList.toggle('chat-open');
  if (open) {
    chatUnread = 0;
    paintChatUnread();
    const log = $('chatlog');
    log.scrollTop = log.scrollHeight;
  }
}

function clearChat() {
  $('chatlog').innerHTML = '';
}

function addChat(kind, text) {
  if ($('chat-card').classList.contains('hidden')) return;
  // In focus mode the Parlour is tucked away — count what arrives unseen.
  if (kind === 'them'
      && document.body.classList.contains('focus')
      && !document.body.classList.contains('chat-open')) {
    chatUnread++;
    paintChatUnread();
  }
  const div = document.createElement('div');
  div.className = 'chat-msg ' + kind;
  if (kind === 'sys') {
    div.textContent = text;
  } else {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = kind === 'you' ? 'You' : 'They';
    const body = document.createElement('span');
    body.textContent = text;
    div.append(who, body);
  }
  const log = $('chatlog');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showWait(role, code) {
  $('wait-title').textContent = role === 'host' ? 'The Table Is Set' : 'Seeking the Table';
  $('wait-text').textContent = role === 'host'
    ? (code ? 'Share this code with the other court:' : 'Reaching the courier network…')
    : 'Knocking with code:';
  $('wait-code').textContent = code || '';
  $('wait-status').textContent = '';
  $('btn-copy-invite').classList.toggle('hidden', role !== 'host' || !code);
  $('ov-wait').classList.remove('hidden');
}

function leaveOnline() {
  if (net) { net.destroy(); net = null; }
  oppHere = false;
  hostRetries = 0;
  showChat(false);
  $('ov-wait').classList.add('hidden');
  if (settings.mode === 'online') settings = { ...settings, mode: 'hotseat' };
}

function netStart(role, code) {
  net = new Net({
    onHostReady: (c) => showWait('host', c),
    onConnect: onPeerConnected,
    onMessage: onNetMessage,
    onClose: onPeerClosed,
    onError: onNetError,
  });
  if (role === 'host') {
    net.host(code);
    showWait('host', null); // the code appears once the network answers
  } else {
    net.join(code);
    showWait('join', code);
  }
}

function leaveTutorial() {
  if (!tut) return;
  tut = null;
  $('tutor-card').classList.add('hidden');
  $('chk-escapes').checked = false;
  settings = { ...settings, mode: 'hotseat' };
}

function startHost(side) {
  leaveTutorial();
  leaveOnline();
  settings = { mode: 'online', humanSide: side, level: 'courtier' };
  hist = [initialState()];
  logEntries = [];
  capturedBy = { [BONE]: [], [ASH]: [] };
  result = null;
  lastMove = null;
  selection = null;
  aiThinking = false;
  flipped = side === ASH;
  $('ov-over').classList.add('hidden');
  $('btn-show-result').classList.add('hidden');
  showChat(true);
  clearChat();
  layoutBoard();
  legalCache = genLegal(cur());
  paint();
  paintLog();
  netStart('host', makeCode());
}

function startJoin(code) {
  leaveTutorial();
  leaveOnline();
  netStart('join', code);
}

function onPeerConnected() {
  oppHere = true;
  hostRetries = 0;
  if (net.role === 'host') {
    $('ov-wait').classList.add('hidden');
    net.send({
      t: 'welcome',
      state: serialize(cur()),
      side: -settings.humanSide,
      log: logEntries,
      capBone: capturedBy[BONE],
      capAsh: capturedBy[ASH],
    });
    addChat('sys', 'The other court has arrived. The game is afoot.');
    paint();
  }
  // The guest waits for the host's welcome before taking a seat.
}

function onNetMessage(msg) {
  switch (msg.t) {
    case 'welcome': {
      if (net?.role !== 'guest') break;
      settings = { mode: 'online', humanSide: msg.side, level: 'courtier' };
      hist = [deserialize(msg.state)];
      logEntries = Array.isArray(msg.log) ? msg.log : [];
      capturedBy = { [BONE]: msg.capBone || [], [ASH]: msg.capAsh || [] };
      result = null;
      lastMove = null;
      selection = null;
      aiThinking = false;
      flipped = settings.humanSide === ASH;
      $('ov-wait').classList.add('hidden');
      $('ov-over').classList.add('hidden');
      $('btn-show-result').classList.add('hidden');
      showChat(true);
      clearChat();
      addChat('sys', `You are seated. You command ${sideName(settings.humanSide)}.`);
      layoutBoard();
      afterPositionChange();
      break;
    }
    case 'move':
      handleRemoteMove(msg);
      break;
    case 'chat':
      addChat('them', String(msg.text || '').slice(0, 300));
      break;
    case 'parley-offer':
      if (result) break;
      confirmDialog('A Parley Is Offered', 'The other court offers a draw. Do you accept?', () => {
        net?.send({ t: 'parley-accept' });
        setResult({ type: 'parley' });
        paint();
      }, () => {
        net?.send({ t: 'parley-decline' });
      });
      break;
    case 'parley-accept':
      if (!result) { setResult({ type: 'parley' }); paint(); }
      break;
    case 'parley-decline':
      $('substatus').textContent = 'The other court declines your parley.';
      addChat('sys', 'The other court declines your parley.');
      break;
    case 'resign':
      if (!result) { setResult({ type: 'resign', loser: -settings.humanSide }); paint(); }
      break;
    case 'claim': {
      if (result) break;
      const claims = claimableDraws(cur());
      if (msg.kind === 'siege' && claims.longSiege) { setResult({ type: 'siege' }); paint(); }
      if (msg.kind === 'winter' && claims.longWinter) { setResult({ type: 'winter' }); paint(); }
      break;
    }
    case 'rematch-offer':
      confirmDialog('A Rematch Is Offered', 'The other court proposes a fresh board, sides exchanged. Accept?', () => {
        net?.send({ t: 'rematch-accept' });
        doRematch();
      }, () => {
        net?.send({ t: 'rematch-decline' });
      });
      break;
    case 'rematch-accept':
      doRematch();
      break;
    case 'rematch-decline':
      addChat('sys', 'The other court declines a rematch.');
      $('btn-over-rematch').disabled = false;
      break;
  }
}

function handleRemoteMove(msg) {
  if (result || !msg.m) return;
  const state = cur();
  // Only the opponent's moves, only on their turn, only if legal here too.
  if (state.turn === settings.humanSide || state.ply !== msg.ply) return desync();
  const mv = legalCache.find((x) => x.from === msg.m.from && x.to === msg.m.to);
  if (!mv) return desync();
  selection = null;
  playMove(mv, true);
}

function desync() {
  addChat('sys', 'The two boards have fallen out of step. Start a fresh game together.');
}

function onPeerClosed() {
  if (!net) return;
  oppHere = false;
  if (!result) {
    addChat('sys', 'The other court has left the table.');
    if (net.role === 'host') {
      showWait('host', net.code);
      $('wait-status').textContent = 'The seat is empty — the same code lets them return.';
    }
  }
  paint();
}

function onNetError(kind) {
  if (kind === 'unavailable-id' && net?.role === 'host' && hostRetries < 3) {
    hostRetries++;
    const old = net; net = null; old.destroy();
    netStart('host', makeCode());
    return;
  }
  const text = kind === 'peer-unavailable'
    ? 'No table answers to that code.'
    : 'The courier network cannot be reached. Try again shortly.';
  if (!$('ov-wait').classList.contains('hidden')) {
    $('wait-status').textContent = text;
  } else {
    addChat('sys', text);
  }
}

function doRematch() {
  settings = { ...settings, humanSide: -settings.humanSide };
  hist = [initialState()];
  logEntries = [];
  capturedBy = { [BONE]: [], [ASH]: [] };
  result = null;
  lastMove = null;
  selection = null;
  flipped = settings.humanSide === ASH;
  $('ov-over').classList.add('hidden');
  $('btn-show-result').classList.add('hidden');
  addChat('sys', `A fresh board. You now command ${sideName(settings.humanSide)}.`);
  layoutBoard();
  legalCache = genLegal(cur());
  paint();
  paintLog();
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

// Re-render everything that shows a piece after the style changes.
function applyPieceSet() {
  syncPieces();
  paint();
  paintLog();
  paintRuleIcons();
}

function paintRuleIcons() {
  document.querySelectorAll('.rule-ico').forEach((el) => {
    el.innerHTML = pieceHTML(prefs.pieceSet, +el.dataset.piece);
  });
}

function paintPieceSetPreview() {
  const types = [KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER];
  $('pieceset-preview').innerHTML = types
    .map((t, i) => `<div class="pv ${i % 2 ? 'ash-piece' : 'bone-piece'}">${pieceHTML(prefs.pieceSet, t)}</div>`)
    .join('');
}

function setFocus(on) {
  document.body.classList.toggle('focus', on);
  if (!on) document.body.classList.remove('chat-open');
  if (on) {
    // Native fullscreen where the platform allows it (not iOS Safari);
    // the CSS focus layout stands on its own either way.
    document.documentElement.requestFullscreen?.()?.catch?.(() => {});
  } else if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

let confirmYes = null;
let confirmNo = null;

function confirmDialog(title, text, onYes, onNo = null) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmYes = onYes;
  confirmNo = onNo;
  $('ov-confirm').classList.remove('hidden');
}

// Themed replacement for window.prompt — resolves to the trimmed string, or null
// if cancelled. Wiring for the form lives in wireUi (see #ov-prompt handlers).
let promptResolve = null;
function promptDialog({ title, note = '', placeholder = '', value = '', ok = 'Confirm' }) {
  $('prompt-title').textContent = title;
  const noteEl = $('prompt-note');
  noteEl.textContent = note;
  noteEl.classList.toggle('hidden', !note);
  const input = $('prompt-input');
  input.value = value;
  input.placeholder = placeholder;
  $('btn-prompt-ok').textContent = ok;
  $('ov-prompt').classList.remove('hidden');
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return new Promise((resolve) => { promptResolve = resolve; });
}
function closePrompt(result) {
  $('ov-prompt').classList.add('hidden');
  const fn = promptResolve;
  promptResolve = null;
  if (fn) fn(result);
}

function wireSeg(id, onPick) {
  const seg = $(id);
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (onPick) onPick(btn.dataset.v);
  });
}

function segValue(id) {
  return $(id).querySelector('.seg-btn.active').dataset.v;
}

function wireUi() {
  $('btn-new').addEventListener('click', () => $('ov-new').classList.remove('hidden'));
  $('btn-new-cancel').addEventListener('click', () => $('ov-new').classList.add('hidden'));
  $('btn-new-start').addEventListener('click', () => {
    leaveTutorial();
    const mode = segValue('seg-mode');
    // "Online" now lives under Two Players → Where: Local / Online.
    if (mode === 'hotseat' && segValue('seg-where') === 'online') {
      if (segValue('seg-net-role') === 'join') {
        const code = normalizeCode($('join-code').value);
        if (!code) { $('join-code').focus(); return; }
        $('ov-new').classList.add('hidden');
        startJoin(code);
      } else {
        $('ov-new').classList.add('hidden');
        startHost(segValue('seg-host-side') === 'bone' ? BONE : ASH);
      }
      return;
    }
    leaveOnline();
    settings = {
      mode,
      humanSide: segValue('seg-side') === 'bone' ? BONE : ASH,
      level: segValue('seg-level'),
    };
    $('ov-new').classList.add('hidden');
    $('ov-over').classList.add('hidden');
    flipped = settings.mode === 'ai' && settings.humanSide === ASH;
    newGame(true);
    layoutBoard();
  });
  const newDlg = $('ov-new').querySelector('.dialog');
  const syncOnlineFields = () => {
    const online = segValue('seg-mode') === 'hotseat' && segValue('seg-where') === 'online';
    newDlg.classList.toggle('mode-online', online);
  };
  wireSeg('seg-mode', (v) => {
    newDlg.classList.toggle('hide-ai', v !== 'ai');
    newDlg.classList.toggle('mode-hotseat', v === 'hotseat');
    syncOnlineFields();
  });
  wireSeg('seg-where', syncOnlineFields);
  wireSeg('seg-side');
  wireSeg('seg-level');
  wireSeg('seg-net-role', (v) => {
    newDlg.classList.toggle('role-join', v === 'join');
  });
  wireSeg('seg-host-side');
  newDlg.classList.add('hide-ai', 'mode-hotseat');

  // Online: waiting overlay, chat, rematch
  $('btn-wait-cancel').addEventListener('click', () => {
    leaveOnline();
    paint();
  });
  $('btn-copy-invite').addEventListener('click', async () => {
    const code = net?.code || '';
    if (!code) return;
    const url = `${location.origin}${location.pathname}?join=${code}`;
    const text = `Kronspiel — join my table with code ${code}: ${url}`;
    try {
      await navigator.clipboard.writeText(text);
      $('wait-status').textContent = 'Invitation copied — paste it to the other court.';
    } catch {
      $('wait-status').textContent = 'Copying failed — share the code above by hand.';
    }
  });
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim().slice(0, 300);
    if (!text || !net?.connected) return;
    net.send({ t: 'chat', text });
    addChat('you', text);
    $('chat-input').value = '';
  });
  $('btn-over-rematch').addEventListener('click', () => {
    if (!net?.connected) return;
    net.send({ t: 'rematch-offer' });
    $('btn-over-rematch').disabled = true;
    addChat('sys', 'You offer a rematch.');
  });

  $('btn-rules').addEventListener('click', () => $('ov-rules').classList.remove('hidden'));
  $('btn-rules-close').addEventListener('click', () => $('ov-rules').classList.add('hidden'));

  // The Primer
  $('btn-primer-rules').addEventListener('click', startTutorial);
  $('btn-primer-new').addEventListener('click', startTutorial);
  $('btn-tutor-next').addEventListener('click', () => { if (tut) tutAdvance(); });
  $('btn-tutor-back').addEventListener('click', () => { if (tut) tutBack(); });
  $('btn-tutor-exit').addEventListener('click', () => { if (tut) exitTutorial(); });

  // Chronicle export
  $('btn-export').addEventListener('click', copyRecord);

  $('btn-options').addEventListener('click', () => {
    $('seg-pieces').querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.v === prefs.pieceSet));
    $('seg-labels').querySelectorAll('.seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.v === (showLabels() ? 'show' : 'hide')));
    paintPieceSetPreview();
    $('ov-options').classList.remove('hidden');
  });
  $('btn-options-close').addEventListener('click', () => $('ov-options').classList.add('hidden'));
  wireSeg('seg-pieces', (v) => {
    prefs.pieceSet = v;
    savePrefs();
    paintPieceSetPreview();
    applyPieceSet();
  });
  wireSeg('seg-labels', (v) => {
    prefs.boardLabels = v === 'show';
    savePrefs();
    applyBoardLabels();
  });

  $('btn-confirm-no').addEventListener('click', () => {
    $('ov-confirm').classList.add('hidden');
    const fn = confirmNo; confirmYes = null; confirmNo = null;
    if (fn) fn();
  });
  $('btn-confirm-yes').addEventListener('click', () => {
    $('ov-confirm').classList.add('hidden');
    const fn = confirmYes; confirmYes = null; confirmNo = null;
    if (fn) fn();
  });

  $('prompt-form').addEventListener('submit', (e) => { e.preventDefault(); closePrompt($('prompt-input').value.trim()); });
  $('btn-prompt-cancel').addEventListener('click', () => closePrompt(null));
  $('ov-prompt').addEventListener('click', (e) => { if (e.target === $('ov-prompt')) closePrompt(null); });

  $('btn-over-new').addEventListener('click', () => {
    $('ov-over').classList.add('hidden');
    $('ov-new').classList.remove('hidden');
  });
  $('btn-show-result').addEventListener('click', showGameOver);

  $('btn-undo').addEventListener('click', undo);
  $('btn-flip').addEventListener('click', () => { flipped = !flipped; selection = null; layoutBoard(); save(); });
  $('btn-parley').addEventListener('click', offerParley);
  $('btn-resign').addEventListener('click', resign);
  $('chk-escapes').addEventListener('change', paint);

  $('btn-siege').addEventListener('click', () => {
    if (isOnline()) net?.send({ t: 'claim', kind: 'siege' });
    setResult({ type: 'siege' }); paint(); save();
  });
  $('btn-winter').addEventListener('click', () => {
    if (isOnline()) net?.send({ t: 'claim', kind: 'winter' });
    setResult({ type: 'winter' }); paint(); save();
  });

  // Full-screen focus mode
  $('btn-focus').addEventListener('click', () => setFocus(!document.body.classList.contains('focus')));
  $('btn-focus-exit').addEventListener('click', () => setFocus(false));
  $('btn-focus-undo').addEventListener('click', undo);
  $('btn-focus-chat').addEventListener('click', toggleFocusChat);
  document.addEventListener('fullscreenchange', () => {
    // leaving native fullscreen (back gesture, Esc) also leaves focus mode
    if (!document.fullscreenElement) {
      document.body.classList.remove('focus');
      document.body.classList.remove('chat-open');
    }
  });

  // click outside a dialog closes the passive ones
  for (const id of ['ov-rules', 'ov-new', 'ov-options']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) $(id).classList.add('hidden');
    });
  }

  initAnnotate();
  initEditor();
  initAnnals();
  initMobileShell();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadPrefs();
applyBoardLabels();
wireUi();
const restored = load();
if (!restored) {
  hist = [initialState()];
}
buildBoard();
paintRuleIcons();
newGame(false);
if (result) {
  $('btn-show-result').classList.remove('hidden');
}

// Shared links open straight into the game.
const bootParams = new URLSearchParams(location.search);
const joinParam = bootParams.get('join');
if (joinParam && normalizeCode(joinParam)) {
  history.replaceState(null, '', location.pathname);
  startJoin(normalizeCode(joinParam));
} else if (bootParams.get('g')) {
  try { startReplay(replayFromShareCode(bootParams.get('g'))); history.replaceState(null, '', location.pathname); } catch { /* bad link */ }
} else if (bootParams.get('p')) {
  try { enterEditor(false); applyCode(bootParams.get('p')); history.replaceState(null, '', location.pathname); } catch { /* bad link */ }
}
