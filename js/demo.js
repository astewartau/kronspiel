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
//       { "0": "Note shown before any move.",
//         "2": "Note shown once ply 2 has been played." }
//     </script>
//   </kron-demo>
//
// Attributes: moves (space-separated from-to), label (optional heading),
// flip (optional; view from Ash's side). Notes are keyed by ply count.

import {
  N, ASCH, EMPTY, KRONE, idx, rowOf, colOf,
  initialState, genLegal, apply, sqName,
} from './engine.js';
import { pieceHTML } from './pieces.js';

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
  .board {
    position: relative;
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
  .piece { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
  .piece svg.sigil {
    width: 82%; height: 82%;
    stroke-linejoin: round; stroke-width: 3;
    filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55));
  }
  .piece.bone svg.sigil { fill: #f3ecdc; stroke: #453b2c; }
  .piece.bone svg.sigil .accent { fill: #453b2c; stroke: none; }
  .piece.ash svg.sigil { fill: #211c17; stroke: rgba(243,236,220,0.6); }
  .piece.ash svg.sigil .accent { fill: #cbbfa8; stroke: none; }
  .files {
    display: flex; justify-content: space-around;
    font-family: "Cinzel", serif; font-size: 9.5px; color: #7d7057;
    margin-top: 3px; letter-spacing: 0.05em;
  }
  .controls {
    display: flex; align-items: center; gap: 6px;
    margin-top: 9px;
  }
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
  .note {
    min-height: 3.2em;
    margin-top: 7px;
    font-size: 14.5px;
    font-style: italic;
    line-height: 1.45;
    color: var(--ink-dim, #9a8f7c);
    text-align: center;
  }
`;

class KronDemo extends HTMLElement {
  connectedCallback() {
    if (this.shadowRoot) return;
    const root = this.attachShadow({ mode: 'open' });

    this.flip = this.hasAttribute('flip');
    this.notes = {};
    const notesEl = this.querySelector('script[type="application/json"]');
    if (notesEl) { try { this.notes = JSON.parse(notesEl.textContent); } catch { /* ignore bad notes */ } }

    // Replay the move list through the engine, keeping every state.
    this.states = [initialState()];
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
      <div class="board"></div>
      <div class="files">${(this.flip ? 'kjihgfedcba' : 'abcdefghijk').split('').map((f) => `<span>${f}</span>`).join('')}</div>
      <div class="controls">
        <button data-go="0" aria-label="Start" title="Start">«</button>
        <button data-go="-1" aria-label="Back" title="Back">‹</button>
        <div class="readout"></div>
        <button data-go="+1" aria-label="Forward" title="Forward">›</button>
        <button data-go="end" aria-label="End" title="End">»</button>
      </div>
      <div class="note"></div>`;
    root.appendChild(frame);

    this.boardEl = frame.querySelector('.board');
    this.readoutEl = frame.querySelector('.readout');
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

    this.goto(0);
  }

  goto(k) {
    this.k = Math.max(0, Math.min(this.played.length, k));
    const state = this.states[this.k];
    const last = this.k > 0 ? this.played[this.k - 1] : null;

    for (const el of this.sqEls) {
      el.classList.remove('from', 'to');
      const sq = +el.dataset.sq;
      if (last && sq === last.from) el.classList.add('from');
      if (last && sq === last.to) el.classList.add('to');
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

    if (!last) {
      this.readoutEl.textContent = 'Start position';
    } else {
      const n = Math.ceil(this.k / 2);
      const side = last.side === 1 ? 'Bone' : 'Ash';
      const sep = last.capture ? '×' : '–';
      this.readoutEl.textContent = `${n}. ${side}: ${sqName(last.from)}${sep}${sqName(last.to)}  ·  ${this.k}/${this.played.length}`;
    }
    this.buttons[0].disabled = this.buttons[1].disabled = this.k === 0;
    this.buttons[2].disabled = this.buttons[3].disabled = this.k === this.played.length;

    // show the note for the highest annotated ply at or below k
    let note = '';
    for (let i = this.k; i >= 0; i--) {
      if (this.notes[i] != null) { note = this.notes[i]; break; }
    }
    this.noteEl.textContent = note;
  }
}

customElements.define('kron-demo', KronDemo);
