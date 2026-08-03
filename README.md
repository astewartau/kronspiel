# Kronspiel

> *"You need not kill a king to finish him. You need only see that he has nowhere left to stand."*

A web implementation of **Kronspiel** ("Crown-play") — an 11×11 court-game in which the king is never captured, only **isolated**. Play it at **https://astewartau.github.io/kronspiel/**.

## The game in one paragraph

Chess-familiar pieces on an 11×11 board whose centre square — the **Aschenstuhl**, the Ash Seat — belongs to no one: nothing may occupy it, and sliding pieces cannot see past it. There is no check, no checkmate, and no stalemate-as-draw. At the start of every turn the moving player's **Krone** is examined: if every square adjacent to him (plus any square still reachable by his once-per-game **Flucht** leap) is occupied, threatened, or off the board — *and* at least one of those squares is an enemy's doing — he is Isolated and the game is instantly over. His own court counts toward the wall. There is no rescue.

The full rulebook is in [`Kronspiel_Rules.md`](Kronspiel_Rules.md).

## Features

- **Hotseat** two-player mode and a **single-player mode** against three levels of AI (Novice / Courtier / Spymaster — iterative-deepening alpha-beta search whose evaluation is built around escape squares, not just material)
- Full rules enforcement: the Aschenstuhl, Die Flucht, Isolation with its no-rescue and no-self-isolation clauses, Bürger promotion (only ever to Gesandter), and every draw form — the Long Siege, the Long Winter, the Empty Court, Mutual Ruin, and Parley
- Escape-square overlay and live escape counters, isolation post-mortem highlighting, move chronicle, undo, board flip, and automatic game saving in the browser

## Development

No build step, no dependencies — plain HTML/CSS/ES modules. Serve the folder and open it:

```sh
python3 -m http.server 8000
```

Run the rules-engine test suite with:

```sh
node test/engine.test.mjs
```

## Credits

Rules compiled for *Den of Snakes*. Implementation by Claude Code.
