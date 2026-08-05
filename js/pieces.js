// Piece rendering — selectable piece styles.
// 'classic'  : the familiar chess glyphs
// 'sigils'   : hand-drawn court sigils for the Kronspiel flavour

import { KRONE, KANZLER, MARSCHALL, PRALAT, GESANDTER, BURGER, GLYPHS } from './engine.js';

// Every sigil lives on a 100×100 viewBox. Silhouettes use currentColor via
// CSS (fill + outline stroke); elements marked class="accent" take the
// opposing tone for interior detail.
const SIGILS = {
  // The Krone — a king's crown: band, three peaks, orbs, cross.
  [KRONE]: `
    <path d="M47.7 2 h4.6 v5.4 h5.4 v4.6 h-5.4 v5.4 h-4.6 v-5.4 h-5.4 v-4.6 h5.4 Z"/>
    <path d="M20 76 L17 46 C24 52 32 55 38 54 C43 53 47 46 50 36 C53 46 57 53 62 54 C68 55 76 52 83 46 L80 76 Z"/>
    <circle cx="17" cy="40" r="5"/>
    <circle cx="83" cy="40" r="5"/>
    <circle cx="50" cy="27" r="5"/>
    <rect x="18" y="76" width="64" height="14" rx="4"/>
    <circle class="accent" cx="32" cy="83" r="3.2"/>
    <circle class="accent" cx="50" cy="83" r="3.2"/>
    <circle class="accent" cx="68" cy="83" r="3.2"/>
  `,
  // The Kanzler — the Reichsapfel: the imperial orb and cross.
  [KANZLER]: `
    <path d="M47 5 h6 v7 h8 v6 h-8 v7 h-6 v-7 h-8 v-6 h8 Z"/>
    <circle cx="50" cy="60" r="28"/>
    <path class="accent" d="M24 56 h52 v7 h-52 Z"/>
    <path class="accent" d="M46.5 63 h7 v23 h-7 Z"/>
    <rect x="37" y="26" width="26" height="9" rx="4"/>
  `,
  // The Marschall — a keep on the road: crenellated tower.
  [MARSCHALL]: `
    <path d="M26 12 h11 v10 h9 v-10 h8 v10 h9 v-10 h11 v22 l-7 8 v34 l9 14 H24 l9 -14 v-34 l-7 -8 Z"/>
    <path class="accent" d="M44 66 a6 8 0 0 1 12 0 v14 h-12 Z"/>
    <rect class="accent" x="45.5" y="44" width="9" height="12" rx="2"/>
  `,
  // The Prälat — the mitre of the Ecclesia.
  [PRALAT]: `
    <path d="M50 8 C63 22 72 44 72 66 L28 66 C28 44 37 22 50 8 Z"/>
    <rect x="24" y="66" width="52" height="12" rx="4"/>
    <path d="M36 78 l-2 13 h9 l1 -13 Z M64 78 l2 13 h-9 l-1 -13 Z"/>
    <path class="accent" d="M46.5 30 h7 v26 h-7 Z"/>
    <path class="accent" d="M38 39 h24 v7 h-24 Z"/>
  `,
  // The Gesandter — the spymaster's raven, perched.
  [GESANDTER]: `
    <path d="M16 30 L34 26 C38 18 48 16 54 24 C66 26 74 38 74 52 C74 58 72 62 68 65 L86 88 L60 76 C48 80 38 74 33 62 C29 52 28 44 28 38 L16 34 Z"/>
    <circle class="accent" cx="42" cy="28" r="3.5"/>
  `,
  // The Bürger — a hooded commoner.
  [BURGER]: `
    <path d="M50 16 C61 16 68 25 68 36 C68 42 65 48 60 51 C70 56 76 66 76 84 L24 84 C24 66 30 56 40 51 C35 48 32 42 32 36 C32 25 39 16 50 16 Z"/>
    <path class="accent" d="M40 38 C42 32 46 29 50 29 C54 29 58 32 60 38 C57 35 54 34 50 34 C46 34 43 35 40 38 Z"/>
  `,
};

export const PIECE_SETS = {
  classic: { label: 'Classic Glyphs' },
  sigils: { label: 'Court Sigils' },
};

// Returns innerHTML for a piece container element.
export function pieceHTML(setId, type) {
  if (setId === 'sigils') {
    return `<svg class="sigil" viewBox="0 0 100 100" aria-hidden="true">${SIGILS[type]}</svg>`;
  }
  return GLYPHS[type];
}

// Raw sigil markup (paths on a 100×100 viewBox), for redrawing pieces into an
// exported board image. Colour is applied by the caller.
export function sigilInner(type) {
  return SIGILS[type];
}
