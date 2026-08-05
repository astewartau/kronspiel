// The Primer — an interactive introduction to Kronspiel, played on the real
// board. Each lesson either narrates (Continue advances) or asks the player
// to make a specific move (making it advances).

import {
  N, idx, initialState, genLegal, apply,
  KRONE, KANZLER, MARSCHALL, GESANDTER, BURGER,
  BONE, ASH,
} from './engine.js';

export const sqOf = (name) => idx(parseInt(name.slice(1), 10) - 1, name.charCodeAt(0) - 97);
const P = (name, type, side) => [sqOf(name), type * side];

// setup: 'initial' | { pieces, turn, flucht } | { initial: true, moves } |
//        null (keep the board as it stands)
// expect: { from, to: [names] | null, hint } — the move the lesson waits for
// arrows: [[from, to], …] — gold sightlines drawn on the board for the lesson
export const LESSONS = [
  {
    title: 'Welcome to the Table',
    text: 'Kronspiel is played to one end only: the enemy Krone must be left with nowhere to stand. '
      + 'He is never captured — no piece may so much as touch him. He is isolated: the moment it is his '
      + 'turn and no square remains for him, his reign is over. This Primer will walk you through how '
      + 'that happens, on a live board.',
    setup: 'initial',
  },
  {
    title: 'The Ash Seat',
    text: 'The marked centre square is the Aschenstuhl — the empty throne. No piece may ever stand '
      + 'upon it, and the sliding pieces cannot see past it. Watch the Kanzler run the whole rank — '
      + 'and halt before the empty chair. It blocks like a wall, but it threatens no one: for the '
      + 'Krone it is simply the edge of the board, brought inward.',
    setup: {
      pieces: [P('a6', KANZLER, BONE), P('f1', KRONE, BONE), P('f11', KRONE, ASH)],
      turn: BONE,
    },
    marks: ['f6'],
    autoMoves: ['a6-e6'],
  },
  {
    title: 'The Krone',
    text: 'Your Krone moves one square in any direction, like a king in chess. '
      + 'Move him now — any square you please.',
    setup: {
      pieces: [P('e6', KRONE, BONE), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    expect: { from: 'e6', to: null, hint: 'Move the Krone one square in any direction.' },
  },
  {
    title: 'Escapes Are Life',
    text: 'The overlay now shows your Krone’s escape squares. Green squares are open — he could '
      + 'go there. Red squares are threatened by the enemy: the Marschall on c8 controls the '
      + 'c-file. The count in the player bar tracks these open doors. When no green remains — '
      + 'and the enemy threatens the Krone’s own square, or any empty square beside him — the '
      + 'game ends, and he loses. Watch that number the way you would watch your own pulse.',
    setup: {
      pieces: [P('c3', KRONE, BONE), P('c8', MARSCHALL, ASH), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    escapes: true,
    arrows: [['c8', 'c4']],
  },
  {
    title: 'A Wall of His Own Men',
    text: 'This Krone is entirely walled in — by his own loyal court. And he is perfectly safe. '
      + 'A Krone is never lost to his own men alone: until an enemy piece threatens his square '
      + 'or an empty square beside him, a crowded court is only a crowded court. But notice how '
      + 'few doors he has left to lose.',
    setup: {
      pieces: [
        P('a1', KRONE, BONE), P('a2', BURGER, BONE), P('b2', BURGER, BONE), P('b1', MARSCHALL, BONE),
        P('k11', KRONE, ASH),
      ],
      turn: BONE,
    },
    escapes: true,
  },
  {
    title: 'Deliver an Isolation',
    text: 'Now stand on the other side of that lesson. The Ash Krone in the corner is walled in by '
      + 'his own men — every neighbouring square filled, nothing empty for you to claim. One piece '
      + 'in the game can still finish him: the Gesandter, whose leap ignores the wall and can '
      + 'threaten the Krone’s own square directly — a blade at his throat. Leap your Gesandter '
      + 'from d8 to b9.',
    setup: {
      pieces: [
        P('a11', KRONE, ASH), P('a10', BURGER, ASH), P('b10', BURGER, ASH), P('b11', MARSCHALL, ASH),
        P('d8', GESANDTER, BONE), P('f2', KRONE, BONE),
      ],
      turn: BONE,
    },
    escapes: true,
    expect: { from: 'd8', to: ['b9'], hint: 'Leap the Gesandter from d8 to b9 — the broken L-step.' },
  },
  {
    title: 'The Message Has Arrived',
    text: 'From b9 your Gesandter threatens the Krone’s own square — a blade at his throat while '
      + 'his own court holds every door shut. The game ended the instant his turn began, before '
      + 'any piece was given leave to act. Mark the Bürger on a10: he stands one diagonal step '
      + 'from your Gesandter — a capture he will never be allowed to make, because there is no '
      + 'turn left to make it in. There is no rescue. You may kill the messenger; the message '
      + 'has already arrived.',
    setup: null,
    escapes: true,
    arrows: [['b9', 'a11'], ['a10', 'b9']],
  },
  {
    title: 'A King Never Touched',
    text: 'That Isolation still looked much like a checkmate: the king directly attacked, every '
      + 'escape barred. Kronspiel can end that way — it does not need to. This Ash Krone is '
      + 'walled in by his own loyal court, and no piece of yours threatens him. None ever will. '
      + 'One neighbouring square is genuinely empty: b10. Threaten it from half a board away — '
      + 'slide your Marschall to b5, and the b-file does the rest.',
    setup: {
      pieces: [
        P('a11', KRONE, ASH), P('a10', BURGER, ASH), P('b11', MARSCHALL, ASH),
        P('g5', MARSCHALL, BONE), P('f2', KRONE, BONE),
      ],
      turn: BONE,
    },
    marks: ['b10'],
    expect: { from: 'g5', to: ['b5'], hint: 'Slide the Marschall along the rank to b5 — the b-file does the rest.' },
  },
  {
    title: 'No Check Ever Came',
    text: 'It is done — and notice what never happened. No piece ever attacked the Krone. There '
      + 'was no check, no warning; Kronspiel has none to give. His Marschall stares down the '
      + 'file at yours — a capture that will never come, because the game ended before his turn '
      + 'began. In chess this position would be nothing: the king is not even attacked, and his '
      + 'army stands alive around him. Here, his reign is over. You do not kill a king in '
      + 'Kronspiel. You see that he has nowhere left to stand.',
    setup: null,
    escapes: true,
    arrows: [['b5', 'b10'], ['b11', 'b5']],
  },
  {
    title: 'Idle Gestures',
    text: 'Notice what did NOT count just now. Your Marschall on b5 also threatens b11 — but b11 '
      + 'is already filled by an Ash piece, and a threat against a square the Krone could never '
      + 'have stepped onto anyway contributes nothing. Such threats are idle gestures. Only two '
      + 'things end a reign: a threat against the Krone’s own square, or a threat against a '
      + 'genuinely empty square beside him. Everything else is theatre.',
    setup: null,
    escapes: true,
  },
  {
    title: 'The Krone Takes No One',
    text: 'The Krone can never be captured — and he captures no one in return. He moves only onto '
      + 'empty squares. An Ash Bürger stands right beside your Krone, undefended. Try to take it: '
      + 'the game will refuse the move. Then step the Krone onto an open square instead — in '
      + 'Kronspiel, walls are walked around, never torn open. (And note the empty throne beside '
      + 'him: no piece may ever stand there, his own included.)',
    setup: {
      pieces: [P('e5', KRONE, BONE), P('e6', BURGER, ASH), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    marks: ['e6'],
    expect: { from: 'e5', to: null, hint: 'The Bürger cannot be taken — step the Krone onto an open square instead.' },
  },
  {
    title: 'No Shelter',
    text: 'The Ash Marschall attacks along the whole rank — straight at the Krone. Could the '
      + 'Krone slip behind himself, to f1? No. Every threat is judged as though the Krone were '
      + 'already lifted off his square: the Marschall’s line runs through the ground he stands '
      + 'on, so the moment he steps aside, it follows him. A king cannot shelter an escape '
      + 'square behind his own body. Look at the overlay: every door burns red. This Krone is '
      + 'already lost.',
    setup: {
      pieces: [
        P('e1', KRONE, BONE), P('d2', BURGER, BONE), P('e2', BURGER, BONE), P('f2', BURGER, BONE),
        P('a1', MARSCHALL, ASH), P('k11', KRONE, ASH),
      ],
      turn: BONE,
    },
    escapes: true,
    arrows: [['a1', 'f1']],
  },
  {
    title: 'The Palsied Court',
    text: 'One door still shows green — b2 — and yet Bone has no legal move at all. Stepping onto '
      + 'b2 would isolate the Krone the moment he arrived, and no player may isolate their own '
      + 'king; the Bürger is blocked dead by the Marschall in front of him. A player with no '
      + 'legal move, while the enemy threatens the Krone’s square or an empty square beside him, '
      + 'loses: the Palsied Court. If a court is stuck with no enemy threat anywhere near the '
      + 'Krone, it is a draw instead — the Frozen Court.',
    setup: {
      pieces: [
        P('a1', KRONE, BONE), P('a2', BURGER, BONE),
        P('a3', MARSCHALL, ASH), P('k1', MARSCHALL, ASH), P('b4', GESANDTER, ASH),
        P('k11', KRONE, ASH),
      ],
      turn: BONE,
    },
    escapes: true,
    marks: ['b2'],
  },
  {
    title: 'Die Flucht',
    text: 'Every court prepares one way out. A Krone who has never moved may — once per game — leap '
      + 'two or three squares in a straight orthogonal line, provided the whole path is empty and '
      + 'unthreatened. Try it: leap your Krone up the f-file, to f3 or f4.',
    setup: {
      pieces: [P('f1', KRONE, BONE), P('k11', KRONE, ASH)],
      turn: BONE,
      flucht: { [BONE]: true, [ASH]: true },
    },
    expect: { from: 'f1', to: ['f3', 'f4'], hint: 'Leap two or three squares up the f-file — f3 or f4.' },
  },
  {
    title: 'The Common Man',
    text: 'The Bürger walks one square forward — or one, two, or three squares straight on his very '
      + 'first step — and takes one square diagonally. He knows one trick no other piece needs: '
      + 'when his file runs dead into the empty throne, he may step diagonally around it, capture or '
      + 'no capture. Your Bürger on f5 stands before the Aschenstuhl now. Step him around it.',
    setup: {
      pieces: [P('f5', BURGER, BONE), P('b1', KRONE, BONE), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    marks: ['f6'],
    expect: { from: 'f5', to: ['e6', 'g6'], hint: 'Step diagonally onto e6 or g6 — around the empty throne.' },
  },
  {
    title: 'The Rising',
    text: 'A Bürger who reaches the far rank promotes — but only ever to a Gesandter, never to a '
      + 'Kanzler, Marschall, or Prälat. A common man may serve power closely; he may never become '
      + 'it. Your Bürger stands one step from the far rank. March him home and watch him rise.',
    setup: {
      pieces: [P('d10', BURGER, BONE), P('b1', KRONE, BONE), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    expect: { from: 'd10', to: ['d11'], hint: 'One more step — d11, and the cloak.' },
  },
  {
    title: 'The Fool’s Gate',
    text: 'One famous trap before you go — every beginner is shown it once. Bone opened with the '
      + 'Bürger’s dash to f5, and Ash answered f10–f9: one step, not three. It looks careful. It '
      + 'is fatal — that pawn now blocks his own Krone’s Flucht up the f-file, and the dash to '
      + 'f5 has opened the long diagonals in front of both your Kanzler. Send one across the '
      + 'whole board: e1 to j6.',
    setup: { initial: true, moves: ['f2-f5', 'f10-f9'] },
    marks: ['f9'],
    expect: { from: 'e1', to: ['j6'], hint: 'Slide the Kanzler the full diagonal — e1 to j6. (g1–b6 would mirror it.)' },
  },
  {
    title: 'The Door Is Bolted',
    text: 'Look at the Ash Krone: every neighbouring square is filled by his own court, and the '
      + 'one empty door — f10 — your Kanzler threatens from ten squares away. His Flucht escape '
      + 'is blocked by his own careful pawn on f9. Isolation is judged at the start of his turn, '
      + 'before any piece may act: the game ended on move two. Dash fully or not at all — and '
      + 'never leave a pawn standing on your own Krone’s escape route.',
    setup: null,
    escapes: true,
    arrows: [['j6', 'f10']],
  },
  {
    title: 'Go Forth',
    text: 'That is the whole of the game: guard your doors, crowd the enemy’s, spend Die Flucht '
      + 'like gold, and never trust a full court room. '
      + 'Leave the Primer when you are ready, and play.',
    setup: null,
  },
];

export function buildTutState(setup) {
  if (setup === 'initial') return initialState();
  if (setup.initial) {
    // The standard opening position with a few plies already played.
    let s = initialState();
    for (const txt of setup.moves || []) {
      const from = sqOf(txt.slice(0, txt.indexOf('-')));
      const to = sqOf(txt.slice(txt.indexOf('-') + 1));
      const m = genLegal(s).find((x) => x.from === from && x.to === to);
      if (!m) throw new Error('Primer: illegal scripted move ' + txt);
      s = apply(s, m);
    }
    return s;
  }
  const board = new Int8Array(N * N);
  for (const [s, v] of setup.pieces) board[s] = v;
  return {
    board,
    turn: setup.turn ?? BONE,
    flucht: { [BONE]: !!setup.flucht?.[BONE], [ASH]: !!setup.flucht?.[ASH] },
    clock: 0,
    reps: {},
    ply: 0,
  };
}
