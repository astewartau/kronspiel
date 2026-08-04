// <kron-demo> — an embeddable, steppable Kronspiel diagram.
//
// A general framework for showing lines of play anywhere (reports, the rules
// page, a future primer). It replays moves through the real engine, so
// captures, dashes, side-steps, Die Flucht and promotion all behave exactly
// as in the game, and renders with the Court Sigils piece set.
//
// Usage:
//   <script type="module" src="js/demo.js"></script>
//   <kron-demo moves="f2-f5 f10-f7 g1-e3" label="The Throne Road">
//     <script type="application/json">
//       { "0": "Plain note shown before any move.",
//         "2": { "note": "Rich step: overlays too.",
//                "doors": "ash",              // paint the Ash Krone's doors
//                "arrows": ["j6-f10"],        // gold sightline arrows
//                "marks": ["f9", "f8"] } }    // gold square marks
//     </script>
//   </kron-demo>
//
// Attributes: moves (space-separated from-to), label (optional heading),
// flip (optional; view from Ash's side). Annotations are keyed by ply count.
// Notes are sticky between keys; doors/arrows/marks apply only at their step.
//
// A staged position (for diagrams that no legal opening reaches) goes in a
// `setup` attribute; with no moves at all, the element renders as a plain
// diagram without controls:
//   <kron-demo setup='{"turn":"ash","pieces":[["b11","KRONE","ash"], ...]}'>
// Winter-variant diagrams may add {"frozenRings":[0]} to a step to paint the
// outermost ring(s) as taken by the winter.

import {
  N, ASCH, EMPTY, idx, rowOf, colOf,
  KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER,
  initialState, genLegal, apply, isolationInfo, sqName, BONE, ASH,
} from './engine.js';
import { pieceHTML } from './pieces.js';

const TYPES = { KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER };

const CSS = `
  :host {
    display: block;
    max-width: 420px;
    margin: 24px auto;
    font-family: "EB Garamond", Georgia, serif;
    color: var(--ink, #d8cfbe);
  }
  .frame {
    background: linear-gradient(135deg, #2b2214 0%, #1b140c 50%, #241a0f 100%);
    border: 1px solid #453823;
    border-radius: 4px;
    box-shadow: 0 0 0 1px #0a0806, 0 14px 40px rgba(0,0,0,0.5), inset 0 0 30px rgba(0,0,0,0.5);
    padding: 10px;
  }
  .label {
    font-family: "Cinzel", serif;
    font-size: 12.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--gold, #c8a24a);
    text-align: center;
    margin: 2px 0 8px;
  }
  .boardwrap { position: relative; }
  .board {
    display: grid;
    grid-template-columns: repeat(11, 1fr);
    grid-template-rows: repeat(11, 1fr);
    aspect-ratio: 1;
    border: 1px solid #0d0a07;
    box-shadow: inset 0 0 24px rgba(0,0,0,0.4);
    user-select: none;
  }
  .sq { position: relative; }
  .sq.bone { background: linear-gradient(145deg, #d2c4a8, #bfae90); }
  .sq.ash  { background: linear-gradient(145deg, #5e564c, #4a4239); }
  .sq.asch {
    background: radial-gradient(circle at 50% 45%, #2b2013 0%, #17130f 60%, #0d0a07 100%);
    box-shadow: inset 0 0 10px rgba(0,0,0,0.95);
  }
  .sq.asch::before {
    content: "♛";
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 1.1em;
    color: rgba(200,162,74,0.3);
  }
  .sq.from { box-shadow: inset 0 0 0 100vmax rgba(200,162,74,0.22); }
  .sq.to   { box-shadow: inset 0 0 0 2px var(--gold, #c8a24a), inset 0 0 12px rgba(200,162,74,0.35); }
  /* door overlays — the game's own visual language */
  .sq.door-open  { box-shadow: inset 0 0 0 2.5px rgba(111,158,95,0.9), inset 0 0 12px rgba(111,158,95,0.35); }
  .sq.door-enemy { box-shadow: inset 0 0 0 2.5px rgba(208,106,74,0.9), inset 0 0 12px rgba(184,68,47,0.4); }
  .sq.door-own   { box-shadow: inset 0 0 0 2.5px rgba(154,143,124,0.65); }
  .sq.door-krone { box-shadow: inset 0 0 0 2.5px rgba(232,201,106,0.95), inset 0 0 14px rgba(200,162,74,0.45); }
  .sq.mark       { box-shadow: inset 0 0 0 2px rgba(232,201,106,0.85), inset 0 0 10px rgba(200,162,74,0.3); }
  .sq.frozen, .sq.frozen.bone, .sq.frozen.ash {
    background: linear-gradient(145deg, #2b3138 0%, #20262d 55%, #181d23 100%);
    box-shadow: inset 0 0 10px rgba(150, 180, 210, 0.12), inset 0 0 0 1px rgba(150, 180, 210, 0.08);
  }
  .piece { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 2; }
  .piece.slide { transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.35, 1); }
  .piece.just-moved svg.sigil { animation: landed 0.45s ease; }
  @keyframes landed {
    0%   { filter: drop-shadow(0 0 8px rgba(232,201,106,0.9)) drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
    100% { filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
  }
  .piece svg.sigil {
    width: 82%; height: 82%;
    stroke-linejoin: round; stroke-width: 3;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55));
  }
  .piece.bone svg.sigil { fill: #f3ecdc; stroke: #453b2c; }
  .piece.bone svg.sigil .accent { fill: #453b2c; stroke: none; }
  .piece.ash svg.sigil { fill: #211c17; stroke: rgba(243,236,220,0.6); }
  .piece.ash svg.sigil .accent { fill: #cbbfa8; stroke: none; }
  svg.overlay {
    position: absolute; inset: 0; width: 100%; height: 100%;
    pointer-events: none; z-index: 3;
  }
  svg.overlay line { stroke: rgba(232,201,106,0.85); stroke-width: 1.1; }
  svg.overlay polygon { fill: rgba(232,201,106,0.85); }
  svg.overlay .halo line { stroke: rgba(200,162,74,0.3); stroke-width: 2.6; }
  .files {
    display: flex; justify-content: space-around;
    font-family: "Cinzel", serif; font-size: 9.5px; color: #7d7057;
    margin-top: 3px; letter-spacing: 0.05em;
  }
  .controls { display: flex; align-items: center; gap: 6px; margin-top: 9px; }
  button {
    font-family: "Cinzel", serif;
    font-size: 13px;
    width: 34px; height: 28px;
    color: var(--ink, #d8cfbe);
    background: linear-gradient(180deg, #2a231a, #1b1712);
    border: 1px solid #3a3226;
    border-radius: 3px;
    cursor: pointer;
    line-height: 1;
  }
  button:hover:not(:disabled) { border-color: var(--gold, #c8a24a); color: var(--gold-bright, #e8c96a); }
  button:disabled { opacity: 0.3; cursor: default; }
  .readout {
    flex: 1;
    text-align: center;
    font-family: "Cinzel", serif;
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--gold-bright, #e8c96a);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .legend {
    display: none;
    justify-content: center;
    gap: 14px;
    margin-top: 7px;
    font-size: 12.5px;
    color: var(--ink-dim, #9a8f7c);
  }
  .legend.show { display: flex; }
  .legend i {
    display: inline-block; width: 10px; height: 10px;
    border-radius: 2px; margin-right: 5px; vertical-align: -1px;
  }
  .legend .open  { box-shadow: inset 0 0 0 2px rgba(111,158,95,0.9); }
  .legend .enemy { box-shadow: inset 0 0 0 2px rgba(208,106,74,0.9); }
  .legend .own   { box-shadow: inset 0 0 0 2px rgba(154,143,124,0.75); }
  .note {
    min-height: 3.2em;
    margin-top: 7px;
    font-size: 14.5px;
    font-style: italic;
    line-height: 1.45;
    color: var(--ink-dim, #9a8f7c);
    text-align: center;
  }
  @media (prefers-reduced-motion: reduce) {
    .piece.slide { transition: none; }
    .piece.just-moved svg.sigil { animation: none; }
  }
`;

class KronDemo extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });

    this.flip = this.hasAttribute('flip');
    this.anno = {};
    const notesEl = this.querySelector('script[type="application/json"]');
    if (notesEl) {
      try {
        const raw = JSON.parse(notesEl.textContent);
        for (const [k, v] of Object.entries(raw)) {
          this.anno[k] = typeof v === 'string' ? { note: v } : v;
        }
      } catch { /* ignore bad notes */ }
    }

    // Starting position: standard, or a staged diagram from `setup`.
    let start = initialState();
    const setupAttr = this.getAttribute('setup');
    if (setupAttr) {
      try {
        const su = JSON.parse(setupAttr);
        const board = new Int8Array(N * N);
        for (const [name, type, side] of su.pieces) {
          board[this.sqOf(name)] = TYPES[type] * (side === 'ash' ? ASH : BONE);
        }
        start = {
          board,
          turn: su.turn === 'ash' ? ASH : BONE,
          flucht: { [BONE]: !!su.flucht?.bone, [ASH]: !!su.flucht?.ash },
          clock: 0, reps: {}, ply: 0,
        };
      } catch (e) { console.warn('<kron-demo> bad setup:', e); }
    }

    // Replay the move list through the engine, keeping every state.
    this.states = [start];
    this.played = []; // {from, to, side, capture}
    for (const txt of (this.getAttribute('moves') || '').trim().split(/\s+/).filter(Boolean)) {
      const mm = txt.match(/^([a-k])(\d+)-([a-k])(\d+)$/);
      const cur = this.states[this.states.length - 1];
      const m = mm && genLegal(cur).find((x) =>
        x.from === idx(+mm[2] - 1, 'abcdefghijk'.indexOf(mm[1])) &&
        x.to === idx(+mm[4] - 1, 'abcdefghijk'.indexOf(mm[3])));
      if (!m) { console.warn('<kron-demo> illegal move in line:', txt); break; }
      this.played.push({ from: m.from, to: m.to, side: cur.turn, capture: cur.board[m.to] !== EMPTY });
      this.states.push(apply(cur, m));
    }

    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const frame = document.createElement('div');
    frame.className = 'frame';
    const label = this.getAttribute('label');
    frame.innerHTML = `
      ${label ? `<div class="label">${label}</div>` : ''}
      <div class="boardwrap">
        <div class="board"></div>
        <svg class="overlay" viewBox="0 0 110 110" preserveAspectRatio="none"></svg>
      </div>
      <div class="files">${(this.flip ? 'kjihgfedcba' : 'abcdefghijk').split('').map((f) => `<span>${f}</span>`).join('')}</div>
      <div class="controls">
        <button data-go="0" aria-label="Start" title="Start">«</button>
        <button data-go="-1" aria-label="Back" title="Back">‹</button>
        <div class="readout"></div>
        <button data-go="+1" aria-label="Forward" title="Forward">›</button>
        <button data-go="end" aria-label="End" title="End">»</button>
      </div>
      <div class="legend">
        <span><i class="open"></i>open door</span>
        <span><i class="enemy"></i>shut by the enemy</span>
        <span><i class="own"></i>shut by his own</span>
      </div>
      <div class="note"></div>`;
    root.appendChild(frame);

    this.boardEl = frame.querySelector('.board');
    this.overlayEl = frame.querySelector('svg.overlay');
    this.readoutEl = frame.querySelector('.readout');
    this.legendEl = frame.querySelector('.legend');
    this.noteEl = frame.querySelector('.note');
    this.buttons = [...frame.querySelectorAll('button')];

    // squares in display order (top-left first)
    this.sqEls = [];
    for (let dr = 0; dr < N; dr++) {
      for (let dc = 0; dc < N; dc++) {
        const r = this.flip ? dr : N - 1 - dr;
        const c = this.flip ? N - 1 - dc : dc;
        const sq = idx(r, c);
        const el = document.createElement('div');
        el.className = 'sq ' + (sq === ASCH ? 'asch' : (r + c) % 2 === 1 ? 'bone' : 'ash');
        el.dataset.sq = sq;
        this.boardEl.appendChild(el);
        this.sqEls.push(el);
      }
    }

    frame.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const g = b.dataset.go;
      this.goto(g === '0' ? 0 : g === 'end' ? this.played.length : this.k + (g === '+1' ? 1 : -1));
    });
    this.tabIndex = 0;
    this.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { this.goto(this.k + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.goto(this.k - 1); e.preventDefault(); }
    });

    this.k = 0;
    this.goto(0);
  }

  // display row/col of a board square
  disp(sq) {
    const r = rowOf(sq), c = colOf(sq);
    return { dr: this.flip ? r : N - 1 - r, dc: this.flip ? N - 1 - c : c };
  }

  sqOf(name) {
    const m = name.match(/^([a-k])(\d+)$/);
    return m ? idx(+m[2] - 1, 'abcdefghijk'.indexOf(m[1])) : -1;
  }

  goto(k) {
    const prev = this.k;
    this.k = Math.max(0, Math.min(this.played.length, k));
    const state = this.states[this.k];
    const last = this.k > 0 ? this.played[this.k - 1] : null;
    const anno = this.anno[this.k] || {};

    // door overlay for the named side, computed by the real engine
    const doors = { krone: -1, open: new Set(), enemy: new Set(), own: new Set() };
    if (anno.doors) {
      const side = anno.doors === 'bone' ? BONE : ASH;
      const info = isolationInfo(state.board, side, state.flucht[side], true);
      doors.krone = info.kSq;
      for (const s of info.open) doors.open.add(s);
      for (const c of info.closed) {
        if (c.occ === 'enemy' || c.threat) doors.enemy.add(c.sq);
        else doors.own.add(c.sq);
      }
    }
    const marks = new Set((anno.marks || []).map((n) => this.sqOf(n)));
    const frozen = new Set();
    for (const ring of anno.frozenRings || []) {
      for (let r = ring; r < N - ring; r++) {
        for (let c = ring; c < N - ring; c++) {
          if (r === ring || r === N - 1 - ring || c === ring || c === N - 1 - ring) frozen.add(idx(r, c));
        }
      }
    }

    for (const el of this.sqEls) {
      el.classList.remove('from', 'to', 'door-open', 'door-enemy', 'door-own', 'door-krone', 'mark', 'frozen');
      if (frozen.has(+el.dataset.sq)) el.classList.add('frozen');
      const sq = +el.dataset.sq;
      if (last && sq === last.from) el.classList.add('from');
      if (last && sq === last.to) el.classList.add('to');
      if (sq === doors.krone) el.classList.add('door-krone');
      else if (doors.open.has(sq)) el.classList.add('door-open');
      else if (doors.enemy.has(sq)) el.classList.add('door-enemy');
      else if (doors.own.has(sq)) el.classList.add('door-own');
      if (marks.has(sq)) el.classList.add('mark');

      const p = state.board[sq];
      let piece = el.querySelector('.piece');
      if (p === EMPTY) { piece?.remove(); continue; }
      if (!piece) {
        piece = document.createElement('div');
        el.appendChild(piece);
      }
      piece.className = 'piece ' + (p > 0 ? 'bone' : 'ash');
      piece.innerHTML = pieceHTML('sigils', Math.abs(p));
    }

    // slide + glow the mover when stepping forward one ply
    if (last && this.k === prev + 1) {
      const destEl = this.sqEls.find((el) => +el.dataset.sq === last.to)?.querySelector('.piece');
      if (destEl) {
        const a = this.disp(last.from), b = this.disp(last.to);
        destEl.style.transform = `translate(${(a.dc - b.dc) * 100}%, ${(a.dr - b.dr) * 100}%)`;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          destEl.classList.add('slide', 'just-moved');
          destEl.style.transform = '';
        }));
        setTimeout(() => destEl.classList.remove('slide', 'just-moved'), 500);
      }
    }

    // sightline arrows
    this.overlayEl.innerHTML = '';
    for (const a of anno.arrows || []) {
      const [f, t] = a.split('-').map((n) => this.sqOf(n));
      if (f < 0 || t < 0) continue;
      const A = this.disp(f), B = this.disp(t);
      const ax = A.dc * 10 + 5, ay = A.dr * 10 + 5;
      let bx = B.dc * 10 + 5, by = B.dr * 10 + 5;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      bx -= ux * 3.4; by -= uy * 3.4; // stop short of the target piece
      const head = 2.4;
      const hx = bx - ux * head, hy = by - uy * head;
      const px = -uy * head * 0.6, py = ux * head * 0.6;
      this.overlayEl.innerHTML += `
        <g class="halo"><line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}"/></g>
        <line x1="${ax}" y1="${ay}" x2="${hx}" y2="${hy}"/>
        <polygon points="${bx},${by} ${hx + px},${hy + py} ${hx - px},${hy - py}"/>`;
    }

    if (this.played.length === 0) {
      this.readoutEl.parentElement.style.display = 'none';
    } else if (!last) {
      this.readoutEl.textContent = 'Start position';
    } else {
      const n = Math.ceil(this.k / 2);
      const side = last.side === 1 ? 'Bone' : 'Ash';
      const sep = last.capture ? '×' : '–';
      this.readoutEl.textContent = `${n}. ${side}: ${sqName(last.from)}${sep}${sqName(last.to)}  ·  ${this.k}/${this.played.length}`;
    }
    this.buttons[0].disabled = this.buttons[1].disabled = this.k === 0;
    this.buttons[2].disabled = this.buttons[3].disabled = this.k === this.played.length;

    this.legendEl.classList.toggle('show', !!anno.doors);

    // show the note for the highest annotated ply at or below k
    let note = '';
    for (let i = this.k; i >= 0; i--) {
      if (this.anno[i]?.note != null) { note = this.anno[i].note; break; }
    }
    this.noteEl.textContent = note;
  }
}

customElements.define('kron-demo', KronDemo);
