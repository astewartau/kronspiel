// Kronspiel rules engine — pure logic, no DOM.
// Board: Int8Array(121), index = row*11 + col. Row 0 is the Bone court's home
// rank; Bone moves toward row 10. Piece values are signed: +side * type.

export const N = 11;
export const ASCH = 5 * N + 5; // the Aschenstuhl — permanently empty, blocks sliders

export const EMPTY = 0;
export const KRONE = 1;
export const KANZLER = 2;
export const MARSCHALL = 3;
export const PRALAT = 4;
export const GESANDTER = 5;
export const BURGER = 6;

export const BONE = 1;
export const ASH = -1;

export const idx = (r, c) => r * N + c;
export const rowOf = (i) => Math.floor(i / N);
export const colOf = (i) => i % N;
export const onBoard = (r, c) => r >= 0 && r < N && c >= 0 && c < N;

const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ALL8 = [...ORTH, ...DIAG];
const LEAPS = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];

export function initialState() {
  const board = new Int8Array(N * N);
  const back = [0, MARSCHALL, GESANDTER, PRALAT, KANZLER, KRONE, KANZLER, PRALAT, GESANDTER, MARSCHALL, 0];
  for (let c = 0; c < N; c++) {
    if (back[c]) {
      board[idx(0, c)] = back[c] * BONE;
      board[idx(10, c)] = back[c] * ASH;
    }
    board[idx(1, c)] = BURGER * BONE;
    board[idx(9, c)] = BURGER * ASH;
  }
  const s = {
    board,
    turn: BONE,
    flucht: { [BONE]: true, [ASH]: true },
    clock: 0,          // plies since last capture or Bürger move
    reps: {},          // position key -> occurrence count
    ply: 0,
  };
  s.reps[positionKey(s)] = 1;
  return s;
}

export function positionKey(s) {
  return s.board.join(',') + '|' + s.turn + '|' + (s.flucht[BONE] ? 1 : 0) + (s.flucht[ASH] ? 1 : 0);
}

export function findKrone(board, side) {
  const target = KRONE * side;
  for (let i = 0; i < N * N; i++) if (board[i] === target) return i;
  return -1;
}

// Is square (index sq) attacked by any piece of `bySide`?
export function attacked(board, sq, bySide) {
  const r = rowOf(sq), c = colOf(sq);
  // Bürger: a pawn of bySide sitting one rank behind (relative to its advance)
  const pr = r - bySide;
  if (pr >= 0 && pr < N) {
    if (c > 0 && board[idx(pr, c - 1)] === BURGER * bySide) return true;
    if (c < N - 1 && board[idx(pr, c + 1)] === BURGER * bySide) return true;
  }
  // Gesandter
  for (const [dr, dc] of LEAPS) {
    const rr = r + dr, cc = c + dc;
    if (onBoard(rr, cc) && board[idx(rr, cc)] === GESANDTER * bySide) return true;
  }
  // Krone
  for (const [dr, dc] of ALL8) {
    const rr = r + dr, cc = c + dc;
    if (onBoard(rr, cc) && board[idx(rr, cc)] === KRONE * bySide) return true;
  }
  // Sliders — blocked by any piece and by the Aschenstuhl
  for (const [dr, dc] of ORTH) {
    let rr = r + dr, cc = c + dc;
    while (onBoard(rr, cc)) {
      const i = idx(rr, cc);
      if (i === ASCH) break;
      const p = board[i];
      if (p !== EMPTY) {
        if (p === MARSCHALL * bySide || p === KANZLER * bySide) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  for (const [dr, dc] of DIAG) {
    let rr = r + dr, cc = c + dc;
    while (onBoard(rr, cc)) {
      const i = idx(rr, cc);
      if (i === ASCH) break;
      const p = board[i];
      if (p !== EMPTY) {
        if (p === PRALAT * bySide || p === KANZLER * bySide) return true;
        break;
      }
      rr += dr; cc += dc;
    }
  }
  return false;
}

// Pseudo-legal move generation for one side.
// Moves: { from, to, promo?, double?, flucht? }
export function genPseudo(board, side, fluchtAvail) {
  const moves = [];
  for (let from = 0; from < N * N; from++) {
    const p = board[from];
    if (p === EMPTY || Math.sign(p) !== side) continue;
    const type = Math.abs(p);
    const r = rowOf(from), c = colOf(from);

    if (type === BURGER) {
      const lastRank = side === BONE ? N - 1 : 0;
      const startRow = side === BONE ? 1 : N - 2;
      const fr = r + side;
      if (fr >= 0 && fr < N) {
        const f1 = idx(fr, c);
        if (f1 !== ASCH && board[f1] === EMPTY) {
          moves.push({ from, to: f1, promo: fr === lastRank });
          if (r === startRow) {
            // First move only: advance two or three squares in a straight line.
            for (let d = 2; d <= 3; d++) {
              const fd = idx(r + side * d, c);
              if (fd === ASCH || board[fd] !== EMPTY) break;
              moves.push({ from, to: fd, dash: d });
            }
          }
        }
        for (const dc of [-1, 1]) {
          const cc = c + dc;
          if (cc < 0 || cc >= N) continue;
          const t = idx(fr, cc);
          const q = board[t];
          if (q !== EMPTY && Math.sign(q) === -side && Math.abs(q) !== KRONE) {
            moves.push({ from, to: t, promo: fr === lastRank });
          } else if (f1 === ASCH && q === EMPTY) {
            // §2: a Bürger whose file runs into the Aschenstuhl (f5/f7) may
            // step diagonally around it — the game's one non-capturing diagonal.
            moves.push({ from, to: t, sidestep: true });
          }
        }
      }
    } else if (type === GESANDTER) {
      for (const [dr, dc] of LEAPS) {
        const rr = r + dr, cc = c + dc;
        if (!onBoard(rr, cc)) continue;
        const t = idx(rr, cc);
        if (t === ASCH) continue;
        const q = board[t];
        if (q === EMPTY || (Math.sign(q) === -side && Math.abs(q) !== KRONE)) moves.push({ from, to: t });
      }
    } else if (type === KRONE) {
      for (const [dr, dc] of ALL8) {
        const rr = r + dr, cc = c + dc;
        if (!onBoard(rr, cc)) continue;
        const t = idx(rr, cc);
        if (t === ASCH) continue;
        // The Krone takes no one (§6): he moves only onto open ground.
        if (board[t] === EMPTY) moves.push({ from, to: t });
      }
      if (fluchtAvail) {
        // Path threats are judged with the Krone lifted (§6): he cannot
        // shelter the road behind his own body.
        board[from] = EMPTY;
        for (const [dr, dc] of ORTH) {
          for (let d = 1; d <= 3; d++) {
            const rr = r + dr * d, cc = c + dc * d;
            if (!onBoard(rr, cc)) break;
            const t = idx(rr, cc);
            if (t === ASCH || board[t] !== EMPTY || attacked(board, t, -side)) break;
            if (d >= 2) moves.push({ from, to: t, flucht: true });
          }
        }
        board[from] = p;
      }
    } else {
      const dirs = type === MARSCHALL ? ORTH : type === PRALAT ? DIAG : ALL8;
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (onBoard(rr, cc)) {
          const t = idx(rr, cc);
          if (t === ASCH) break;
          const q = board[t];
          if (q === EMPTY) {
            moves.push({ from, to: t });
          } else {
            // The Krone can never be taken (§6): capturing him is not a legal move.
            if (Math.sign(q) === -side && Math.abs(q) !== KRONE) moves.push({ from, to: t });
            break;
          }
          rr += dr; cc += dc;
        }
      }
    }
  }
  return moves;
}

// Isolation (§6). Returns { isolated, enemyTouch, kSq, open: [sq...], closed: [{sq, occ, threat, edge}] }
// `open` includes Flucht destinations reachable by a fully legal Flucht leap.
// Condition 2 (enemyTouch) holds only when the Krone's own square is directly
// threatened, or an enemy piece threatens a genuinely empty square — one held
// by no piece of either colour. A threat against a square already filled, by
// either side, contributes nothing: that door was never going to open for him.
export function isolationInfo(board, side, fluchtAvail, full = false) {
  const kSq = findKrone(board, side);
  if (kSq === -1) return { isolated: false, enemyTouch: false, kSq, open: [], closed: [] };
  const r = rowOf(kSq), c = colOf(kSq);
  const open = [];
  const closed = [];
  // Every threat below is judged with the Krone lifted from his square (§6):
  // a slider's line runs through the ground he stands on, so he can never
  // shelter an escape square behind his own body.
  const lifted = board[kSq];
  board[kSq] = EMPTY;
  let enemyTouch = attacked(board, kSq, -side); // a blade at his own throat

  for (const [dr, dc] of ALL8) {
    const rr = r + dr, cc = c + dc;
    if (!onBoard(rr, cc)) continue; // off the edge: closed, never enemy's doing
    const i = idx(rr, cc);
    if (i === ASCH) {
      if (full) closed.push({ sq: i, occ: null, threat: false, asch: true });
      continue; // behaves as the board's edge (§2)
    }
    const q = board[i];
    if (q !== EMPTY) {
      // Occupied by either colour: closed ground, but never part of the siege.
      if (full) closed.push({ sq: i, occ: Math.sign(q) === -side ? 'enemy' : 'own', threat: false });
    } else if (attacked(board, i, -side)) {
      enemyTouch = true;
      if (full) closed.push({ sq: i, occ: null, threat: true });
    } else {
      open.push(i);
      if (!full && enemyTouch) break; // fast path: outcome already decided
    }
  }

  // Die Flucht squares count toward Isolation when the path is *physically*
  // unobstructed (§6). Threats close a square but do not obstruct the path —
  // and a threatened Flucht square is a genuinely empty door nailed shut by
  // the enemy alone, so it counts toward condition 2.
  if (fluchtAvail && (full || open.length === 0)) {
    for (const [dr, dc] of ORTH) {
      for (let d = 1; d <= 3; d++) {
        const rr = r + dr * d, cc = c + dc * d;
        if (!onBoard(rr, cc)) break;
        const i = idx(rr, cc);
        if (i === ASCH || board[i] !== EMPTY) break;
        if (d >= 2) {
          if (attacked(board, i, -side)) {
            enemyTouch = true;
            if (full) closed.push({ sq: i, occ: null, threat: true, flucht: true });
          } else {
            open.push(i);
          }
        }
      }
    }
  }

  board[kSq] = lifted;
  return { isolated: open.length === 0 && enemyTouch, enemyTouch, kSq, open, closed };
}

// Apply a move to a board in place; returns undo info.
export function make(board, m) {
  const piece = board[m.from];
  const captured = board[m.to];
  board[m.from] = EMPTY;
  board[m.to] = m.promo ? GESANDTER * Math.sign(piece) : piece;
  return { piece, captured };
}

export function unmake(board, m, u) {
  board[m.from] = u.piece;
  board[m.to] = u.captured;
}

// Full legality for the side to move in `state`:
//  - a Krone may never end its move on a threatened square
//  - no move may leave the mover's own Krone isolated (§6 safeguard)
export function genLegal(state) {
  const { board, turn, flucht } = state;
  const pseudo = genPseudo(board, turn, flucht[turn]);
  const legal = [];
  for (const m of pseudo) {
    const u = make(board, m);
    const movedKrone = Math.abs(u.piece) === KRONE;
    let ok = true;
    if (movedKrone && attacked(board, m.to, -turn)) ok = false;
    if (ok) {
      const fluchtAfter = flucht[turn] && !movedKrone;
      if (isolationInfo(board, turn, fluchtAfter).isolated) ok = false;
    }
    unmake(board, m, u);
    if (ok) legal.push(m);
  }
  return legal;
}

// Apply a move to a full game state, returning a new state (the old one is untouched).
export function apply(state, m) {
  const board = new Int8Array(state.board);
  const u = make(board, m);
  const isPawn = Math.abs(u.piece) === BURGER;
  const movedKrone = Math.abs(u.piece) === KRONE;
  const s = {
    board,
    turn: -state.turn,
    flucht: {
      [BONE]: state.flucht[BONE] && !(state.turn === BONE && movedKrone),
      [ASH]: state.flucht[ASH] && !(state.turn === ASH && movedKrone),
    },
    clock: (isPawn || u.captured !== EMPTY) ? 0 : state.clock + 1,
    reps: { ...state.reps },
    ply: state.ply + 1,
  };
  const key = positionKey(s);
  s.reps[key] = (s.reps[key] || 0) + 1;
  return s;
}

// Automatic / claimable game-end checks at the start of `state.turn`'s turn.
// Returns null, or { type, loser?, ... }
//   type: 'isolation' | 'mutual' | 'empty' | 'palsy' | 'frozen'
export function turnStartResult(state, legalMoves) {
  const { board, turn, flucht } = state;
  const mine = isolationInfo(board, turn, flucht[turn], true);
  if (mine.isolated) {
    const theirs = isolationInfo(board, -turn, flucht[-turn]);
    if (theirs.isolated) return { type: 'mutual', info: mine };
    return { type: 'isolation', loser: turn, info: mine };
  }
  // The Empty Court: a lone Krone against a lone Krone
  let others = 0;
  for (let i = 0; i < N * N; i++) {
    const p = board[i];
    if (p !== EMPTY && Math.abs(p) !== KRONE) { others++; break; }
  }
  if (others === 0) return { type: 'empty' };
  if (legalMoves.length === 0) {
    // The Palsied Court (§6): no legal move left while the enemy's hand is on
    // the wall — a loss. Without enemy touch it is the Frozen Court, a draw (§7).
    if (mine.enemyTouch) return { type: 'palsy', loser: turn, info: mine };
    return { type: 'frozen' };
  }
  return null;
}

export function claimableDraws(state) {
  return {
    longSiege: (state.reps[positionKey(state)] || 0) >= 3,
    longWinter: state.clock >= 100, // fifty full moves by each side
  };
}

export function serialize(state) {
  return {
    board: Array.from(state.board),
    turn: state.turn,
    flucht: { [BONE]: state.flucht[BONE], [ASH]: state.flucht[ASH] },
    clock: state.clock,
    reps: state.reps,
    ply: state.ply,
  };
}

export function deserialize(o) {
  return {
    board: Int8Array.from(o.board),
    turn: o.turn,
    flucht: { [BONE]: !!o.flucht[BONE], [ASH]: !!o.flucht[ASH] },
    clock: o.clock,
    reps: o.reps || {},
    ply: o.ply || 0,
  };
}

// Notation helpers -----------------------------------------------------------
const FILES = 'abcdefghijk';
export const sqName = (i) => FILES[colOf(i)] + (rowOf(i) + 1);

export const GLYPHS = {
  [KRONE]: '♚', [KANZLER]: '♛', [MARSCHALL]: '♜',
  [PRALAT]: '♝', [GESANDTER]: '♞', [BURGER]: '♟',
};

export const PIECE_NAMES = {
  [KRONE]: 'Krone', [KANZLER]: 'Kanzler', [MARSCHALL]: 'Marschall',
  [PRALAT]: 'Prälat', [GESANDTER]: 'Gesandter', [BURGER]: 'Bürger',
};

// Move text without the piece symbol — callers prepend an icon of their choice.
// Separators: × capture, » first-move dash, ↷ side-step around the throne.
export function notateBody(stateBefore, m) {
  const capture = stateBefore.board[m.to] !== EMPTY;
  const sep = capture ? '×' : m.dash ? '»' : m.sidestep ? '↷' : '–';
  let s = sqName(m.from) + sep + sqName(m.to);
  if (m.flucht) s += ' (Flucht)';
  if (m.promo) s += '=' + GLYPHS[GESANDTER];
  return s;
}

export function notate(stateBefore, m) {
  const piece = Math.abs(stateBefore.board[m.from]);
  return GLYPHS[piece] + ' ' + notateBody(stateBefore, m);
}
