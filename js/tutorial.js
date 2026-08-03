// The Primer — an interactive introduction to Kronspiel, played on the real
// board. Each lesson either narrates (Continue advances) or asks the player
// to make a specific move (making it advances).

import {
  N, idx, initialState,
  KRONE, MARSCHALL, GESANDTER, BURGER,
  BONE, ASH,
} from './engine.js';

export const sqOf = (name) => idx(parseInt(name.slice(1), 10) - 1, name.charCodeAt(0) - 97);
const P = (name, type, side) => [sqOf(name), type * side];

// setup: 'initial' | { pieces, turn, flucht } | null (keep the board as it stands)
// expect: { from, to: [names] | null, hint } — the move the lesson waits for
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
      + 'upon it, and the sliding pieces cannot see past it. It blocks like a wall, but it threatens '
      + 'no one: for the Krone it is simply the edge of the board, brought inward.',
    setup: 'initial',
    marks: ['f6'],
  },
  {
    title: 'The Krone',
    text: 'Your Krone moves one square in any direction, like a king of the foreign game. '
      + 'Move him now — any square you please.',
    setup: {
      pieces: [P('e6', KRONE, BONE), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    expect: { from: 'e6', to: null, hint: 'Move the Krone one square in any direction.' },
  },
  {
    title: 'Escapes Are Life',
    text: 'The overlay now shows your Krone’s standing. Green squares are open — he could go '
      + 'there. Red squares are claimed by the enemy: the Marschall on c8 bears down the file. '
      + 'The count in the player bar tracks these open doors. When they reach zero under enemy '
      + 'touch, the game ends. Watch that number the way you would watch your own pulse.',
    setup: {
      pieces: [P('c3', KRONE, BONE), P('c8', MARSCHALL, ASH), P('k11', KRONE, ASH)],
      turn: BONE,
    },
    escapes: true,
  },
  {
    title: 'A Wall of His Own Men',
    text: 'This Krone is entirely walled in — by his own loyal court. And he is perfectly safe. '
      + 'A Krone is never undone by his own house alone: with no enemy hand in the matter, '
      + 'a crowded court is only a crowded court. But mark how few doors he has left to lose.',
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
      + 'in the game can still finish him: the Gesandter, who leaps walls and can lay a blade at the '
      + 'Krone’s own square. Leap your Gesandter from d8 to b9.',
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
      + 'his own court holds every door shut. Were this a real game it would already be over: '
      + 'Isolation is judged at the start of his turn, before any piece may act. His Marschall '
      + 'could capture your Gesandter next move. It does not matter. There is no rescue — you may '
      + 'kill the messenger; the message has already arrived.',
    setup: null,
    escapes: true,
  },
  {
    title: 'Idle Gestures',
    text: 'Note what did NOT work here: pieces glaring at squares the Ash court already fills. '
      + 'A threat against ground the Krone could never have reached is not a siege — only an idle '
      + 'gesture. Only two things end a reign: a blade at the Krone’s own square, or an enemy claim '
      + 'on a genuinely empty door. And remember — the Krone can never be captured. A piece may '
      + 'threaten him forever; it may never take him. Everything but Isolation is theatre.',
    setup: null,
    escapes: true,
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
    title: 'Go Forth',
    text: 'One last thing: a Bürger who crosses the whole board rises — but only ever to a Gesandter. '
      + 'A common man may serve power closely; he may never become it. That is the whole of the game: '
      + 'guard your doors, crowd the enemy’s, and never trust a full court room. '
      + 'Leave the Primer when you are ready, and play.',
    setup: null,
  },
];

export function buildTutState(setup) {
  if (setup === 'initial') return initialState();
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
