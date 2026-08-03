// Kronspiel UI — rendering, interaction, game flow.

import {
  N, ASCH, EMPTY, KRONE, BURGER, GESANDTER, BONE, ASH,
  idx, rowOf, colOf,
  initialState, genLegal, apply, turnStartResult, claimableDraws,
  isolationInfo, notate, serialize, deserialize, sqName,
  GLYPHS, PIECE_NAMES,
} from './engine.js';
import { findBestMove, quickEval } from './ai.js';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'kronspiel-save-v1';

// ---------------------------------------------------------------------------
// Game session state
// ---------------------------------------------------------------------------

let settings = { mode: 'hotseat', humanSide: BONE, level: 'courtier' };
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

const cur = () => hist[hist.length - 1];
const sideName = (s) => (s === BONE ? 'The Bone Court' : 'The Ash Court');
const isAiTurn = () => settings.mode === 'ai' && !result && cur().turn === -settings.humanSide;

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
}

function placePiece(el, sq) {
  const { dr, dc } = sqToDisp(sq);
  el.style.transform = `translate(${dc * 100}%, ${dr * 100}%)`;
}

function makePieceEl(val, sq) {
  const el = document.createElement('div');
  el.className = 'piece ' + (val > 0 ? 'bone-piece' : 'ash-piece');
  el.textContent = GLYPHS[Math.abs(val)];
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
      if (m.promo) el.textContent = GLYPHS[GESANDTER];
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
  const doom = result && (result.type === 'isolation' || result.type === 'mutual') ? result.info : null;

  const legalFrom = selection !== null
    ? legalCache.filter((m) => m.from === selection)
    : [];

  const warnInfo = !result
    ? isolationInfo(state.board, state.turn, state.flucht[state.turn], true)
    : null;

  for (const el of squares) {
    const sq = +el.dataset.sq;
    el.classList.remove('sel', 'move', 'capture', 'flucht-target', 'last-from', 'last-to',
      'esc-open', 'esc-enemy', 'esc-own', 'doom-enemy', 'doom-own', 'doom-krone', 'krone-warn');
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
    }
    name.textContent = label;
    sig.className = 'court-sigil ' + (side === BONE ? 'bone' : 'ash');
    bar.classList.toggle('active', !result && state.turn === side);
    const info = isolationInfo(state.board, side, state.flucht[side], true);
    const n = info.open.length;
    esc.textContent = `${n} escape${n === 1 ? '' : 's'}`;
    esc.classList.toggle('tight', n <= 2);
    // captured pieces: pieces this side has taken (of the enemy's colour)
    const taken = capturedBy[side];
    cap.innerHTML = taken
      .map((t) => `<span class="${side === BONE ? 'ash-piece' : 'bone-piece'}">${GLYPHS[t]}</span>`)
      .join('');
  }
}

function paintStatus() {
  const st = $('status'), sub = $('substatus');
  st.classList.toggle('thinking', aiThinking);
  if (result) {
    st.textContent = result.label;
    sub.textContent = result.short || '';
    return;
  }
  const state = cur();
  if (aiThinking) {
    st.textContent = 'The Court deliberates';
    sub.textContent = '';
    return;
  }
  st.textContent = `${sideName(state.turn)} to move.`;
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

function paintControls() {
  const interactive = !result && !aiThinking;
  $('btn-undo').disabled = hist.length < 2 || aiThinking;
  $('btn-parley').disabled = !interactive;
  $('btn-resign').disabled = !interactive;
  const claims = !result && !aiThinking ? claimableDraws(cur()) : { longSiege: false, longWinter: false };
  const humanCanClaim = settings.mode === 'hotseat' || cur().turn === settings.humanSide;
  $('btn-siege').classList.toggle('hidden', !(claims.longSiege && humanCanClaim));
  $('btn-winter').classList.toggle('hidden', !(claims.longWinter && humanCanClaim));
  $('claims').classList.toggle('hidden',
    $('btn-siege').classList.contains('hidden') && $('btn-winter').classList.contains('hidden'));
}

function paintLog() {
  const ol = $('movelog');
  ol.innerHTML = '';
  for (let i = 0; i < logEntries.length; i += 2) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = (i / 2 + 1) + '.';
    const m1 = document.createElement('span');
    m1.className = 'm bone-piece';
    m1.textContent = logEntries[i].text;
    li.append(n, m1);
    if (logEntries[i + 1]) {
      const m2 = document.createElement('span');
      m2.className = 'm ash-piece';
      m2.textContent = logEntries[i + 1].text;
      li.append(m2);
    }
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function onBoardClick(e) {
  const sqEl = e.target.closest('.sq');
  if (!sqEl || result || aiThinking) return;
  if (settings.mode === 'ai' && cur().turn !== settings.humanSide) return;
  const sq = +sqEl.dataset.sq;
  const state = cur();

  if (selection !== null) {
    const mv = legalCache.find((m) => m.from === selection && m.to === sq);
    if (mv) {
      selection = null;
      playMove(mv);
      return;
    }
  }
  const p = state.board[sq];
  if (p !== EMPTY && Math.sign(p) === state.turn) {
    selection = selection === sq ? null : sq;
  } else {
    selection = null;
  }
  paint();
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function playMove(m) {
  const before = cur();
  const capturedVal = before.board[m.to];
  const text = notate(before, m);
  const next = apply(before, m);
  hist.push(next);
  logEntries.push({ ply: before.ply, side: before.turn, text });
  if (capturedVal !== EMPTY) capturedBy[before.turn].push(Math.abs(capturedVal));
  lastMove = { from: m.from, to: m.to };
  animateMove(m);
  afterPositionChange();
}

function afterPositionChange() {
  const state = cur();
  legalCache = result ? [] : genLegal(state);

  if (!result) {
    const end = turnStartResult(state, legalCache);
    if (end) setResult(end);
  }

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
    case 'frozen':
      r.label = 'The court is frozen — the game is drawn.';
      r.title = 'A Frozen Court';
      r.text = 'No legal move remains, yet the Krone is not isolated. The rules of the capital are silent here; this table calls it a draw.';
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
  $('ov-over').classList.remove('hidden');
  $('btn-show-result').classList.add('hidden');
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

function scheduleAiMove() {
  aiThinking = true;
  paint();
  const started = Date.now();
  setTimeout(() => {
    const m = findBestMove(cur(), settings.level);
    const elapsed = Date.now() - started;
    const wait = Math.max(0, 450 - elapsed); // let the court appear to think
    setTimeout(() => {
      aiThinking = false;
      if (m && !result) playMove(m);
      else if (!result) afterPositionChange();
    }, wait);
  }, 60);
}

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

function newGame(fresh) {
  if (fresh) {
    hist = [initialState()];
    logEntries = [];
    capturedBy = { [BONE]: [], [ASH]: [] };
    result = null;
    lastMove = null;
    selection = null;
    aiThinking = false;
  }
  syncPieces();
  legalCache = result ? [] : genLegal(cur());
  paint();
  paintLog();
  save();
  if (!result && isAiTurn()) scheduleAiMove();
}

function undo() {
  if (hist.length < 2 || aiThinking) return;
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
  const loser = settings.mode === 'ai' ? settings.humanSide : cur().turn;
  confirmDialog('Resign the Board', `${sideName(loser)} yields the game. Are you certain?`, () => {
    setResult({ type: 'resign', loser });
    paint(); save();
  });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      settings: { ...settings },
      hist: hist.map(serialize),
      logEntries,
      capturedBy: { [BONE]: capturedBy[BONE], [ASH]: capturedBy[ASH] },
      result: result ? { ...result, info: null } : null,
      flipped,
      lastMove,
    }));
  } catch { /* storage unavailable — play on without saving */ }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (!o.hist || !o.hist.length) return false;
    settings = o.settings;
    hist = o.hist.map(deserialize);
    logEntries = o.logEntries || [];
    capturedBy = { [BONE]: o.capturedBy?.[BONE] || [], [ASH]: o.capturedBy?.[ASH] || [] };
    result = o.result || null;
    flipped = !!o.flipped;
    lastMove = o.lastMove || null;
    if (result && (result.type === 'isolation' || result.type === 'mutual')) {
      // recompute the doom overlay from the final position
      const s = cur();
      const info = isolationInfo(s.board, s.turn, s.flucht[s.turn], true);
      if (info.isolated) result.info = info;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

let confirmYes = null;

function confirmDialog(title, text, onYes) {
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  confirmYes = onYes;
  $('ov-confirm').classList.remove('hidden');
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
    settings = {
      mode: segValue('seg-mode'),
      humanSide: segValue('seg-side') === 'bone' ? BONE : ASH,
      level: segValue('seg-level'),
    };
    $('ov-new').classList.add('hidden');
    $('ov-over').classList.add('hidden');
    flipped = settings.mode === 'ai' && settings.humanSide === ASH;
    newGame(true);
    layoutBoard();
  });
  wireSeg('seg-mode', (v) => {
    $('ov-new').querySelector('.dialog').classList.toggle('hide-ai', v !== 'ai');
  });
  wireSeg('seg-side');
  wireSeg('seg-level');
  $('ov-new').querySelector('.dialog').classList.add('hide-ai');

  $('btn-rules').addEventListener('click', () => $('ov-rules').classList.remove('hidden'));
  $('btn-rules-close').addEventListener('click', () => $('ov-rules').classList.add('hidden'));

  $('btn-confirm-no').addEventListener('click', () => { confirmYes = null; $('ov-confirm').classList.add('hidden'); });
  $('btn-confirm-yes').addEventListener('click', () => {
    $('ov-confirm').classList.add('hidden');
    const fn = confirmYes; confirmYes = null;
    if (fn) fn();
  });

  $('btn-over-new').addEventListener('click', () => {
    $('ov-over').classList.add('hidden');
    $('ov-new').classList.remove('hidden');
  });
  $('btn-over-board').addEventListener('click', () => {
    $('ov-over').classList.add('hidden');
    $('btn-show-result').classList.remove('hidden');
  });
  $('btn-show-result').addEventListener('click', showGameOver);

  $('btn-undo').addEventListener('click', undo);
  $('btn-flip').addEventListener('click', () => { flipped = !flipped; selection = null; layoutBoard(); save(); });
  $('btn-parley').addEventListener('click', offerParley);
  $('btn-resign').addEventListener('click', resign);
  $('chk-escapes').addEventListener('change', paint);

  $('btn-siege').addEventListener('click', () => { setResult({ type: 'siege' }); paint(); save(); });
  $('btn-winter').addEventListener('click', () => { setResult({ type: 'winter' }); paint(); save(); });

  // click outside a dialog closes the passive ones
  for (const id of ['ov-rules', 'ov-new']) {
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) $(id).classList.add('hidden');
    });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

wireUi();
const restored = load();
if (!restored) {
  hist = [initialState()];
}
buildBoard();
newGame(false);
if (result) {
  $('btn-show-result').classList.remove('hidden');
}
