// Generates patched engine/ai copies for rule variants under sim/variants/.
// The real game code in js/ is never modified.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const engineSrc = await readFile(join(ROOT, 'js/engine.js'), 'utf8');
const aiSrc = await readFile(join(ROOT, 'js/ai.js'), 'utf8');

// Apply replacements, asserting each `from` occurs exactly `count` times.
function patch(src, edits, label) {
  let out = src;
  for (const { from, to, count = 1 } of edits) {
    const n = out.split(from).length - 1;
    if (n !== count) throw new Error(`${label}: expected ${count}× ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
    out = out.split(from).join(to);
  }
  return out;
}

// --- engine patch: loose enemy-touch (pre-update isolation rule) ---
const engineLoose = patch(engineSrc, [{
  from: `    if (q !== EMPTY) {
      // Occupied by either colour: closed ground, but never part of the siege.
      if (full) closed.push({ sq: i, occ: Math.sign(q) === -side ? 'enemy' : 'own', threat: false });
    } else if (attacked(board, i, -side)) {`,
  to: `    if (q !== EMPTY) {
      // LOOSE VARIANT: enemy occupation or a threat against any adjacent
      // square counts toward the siege, occupied or not.
      const threat = Math.sign(q) === -side || attacked(board, i, -side);
      if (threat) enemyTouch = true;
      if (full) closed.push({ sq: i, occ: Math.sign(q) === -side ? 'enemy' : 'own', threat });
    } else if (attacked(board, i, -side)) {`,
}], 'engine/loose');

// --- engine patch: advancing winter — frozen squares behave as the Aschenstuhl ---
const engineWinter = patch(engineSrc, [
  {
    from: "export const ASCH = 5 * N + 5; // the Aschenstuhl — permanently empty, blocks sliders",
    to: `export const ASCH = 5 * N + 5; // the Aschenstuhl — permanently empty, blocks sliders
// WINTER VARIANT: squares taken by the advancing winter behave as the Aschenstuhl.
export const FROZEN = new Set();
const blocked = (i) => i === ASCH || FROZEN.has(i);`,
  },
  { from: "      if (i === ASCH) break;", to: "      if (blocked(i)) break;", count: 2 },
  { from: "        if (f1 !== ASCH && board[f1] === EMPTY) {", to: "        if (!blocked(f1) && board[f1] === EMPTY) {" },
  { from: "              if (fd === ASCH || board[fd] !== EMPTY) break;", to: "              if (blocked(fd) || board[fd] !== EMPTY) break;" },
  { from: "        if (t === ASCH) continue;", to: "        if (blocked(t)) continue;", count: 2 },
  { from: "            if (t === ASCH || board[t] !== EMPTY || attacked(board, t, -side)) break;", to: "            if (blocked(t) || board[t] !== EMPTY || attacked(board, t, -side)) break;" },
  { from: "          if (t === ASCH) break;", to: "          if (blocked(t)) break;" },
  { from: "    if (i === ASCH) {", to: "    if (blocked(i)) {" },
  { from: "        if (i === ASCH || board[i] !== EMPTY) break;", to: "        if (blocked(i) || board[i] !== EMPTY) break;" },
], 'engine/winter');

// --- ai patch: expose root move scores for opening analysis ---
const aiAnalysis = patch(aiSrc, [{
  from: "  // A court playing its opening keeps to the script while the script holds up.",
  to: `  findBestMove.lastScores = bestByDepth.map((x) => ({ from: x.m.from, to: x.m.to, v: x.v }));
  // A court playing its opening keeps to the script while the script holds up.`,
}], 'ai/analysis');

// --- Flucht / Isolation reconciliation variants (the "Flight" question) ---
// Baseline is inconsistent: the Flucht MOVE forbids a threatened pass-through,
// but the isolation TEST credits an escape across one. Three fixes:

// Option A: the isolation test requires a *legal* Flucht (unthreatened path),
// matching the move. Consequence: Flucht can never rescue a besieged Krone.
const engineFluchtA = patch(engineSrc, [{
  from: `        if (i === ASCH || board[i] !== EMPTY) break;
        if (d >= 2) {
          if (attacked(board, i, -side)) {
            enemyTouch = true;
            if (full) closed.push({ sq: i, occ: null, threat: true, flucht: true });
          } else {
            open.push(i);
          }
        }`,
  to: `        if (i === ASCH || board[i] !== EMPTY) break;
        if (attacked(board, i, -side)) {
          if (d >= 2) { enemyTouch = true; if (full) closed.push({ sq: i, occ: null, threat: true, flucht: true }); }
          break; // OPTION A: a threatened pass-through square shuts the road
        }
        if (d >= 2) open.push(i);`,
}], 'engine/fluchtA');

// Option B (and C): the Flucht MOVE may leap OVER threatened squares — only the
// landing must be empty and unthreatened. The isolation test (unchanged) now
// matches the move, so a besieged Krone with a safe landing is genuinely free.
const engineFluchtB = patch(engineSrc, [{
  from: `            if (t === ASCH || board[t] !== EMPTY || attacked(board, t, -side)) break;
            if (d >= 2) moves.push({ from, to: t, flucht: true });`,
  to: `            if (t === ASCH || board[t] !== EMPTY) break;
            // OPTION B/C: leap over threatened squares; only the landing must be safe.
            if (d >= 2 && !attacked(board, t, -side)) moves.push({ from, to: t, flucht: true });`,
}], 'engine/fluchtB');

const variants = {
  baseline: { engine: engineSrc, ai: aiSrc },
  analysis: { engine: engineSrc, ai: aiAnalysis },
  loose: { engine: engineLoose, ai: aiSrc },
  winter: { engine: engineWinter, ai: aiSrc },
  fluchtA: { engine: engineFluchtA, ai: aiSrc },
  fluchtB: { engine: engineFluchtB, ai: aiSrc },
};

for (const [name, files] of Object.entries(variants)) {
  const dir = join(ROOT, 'sim/variants', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'engine.js'), files.engine);
  await writeFile(join(dir, 'ai.js'), files.ai);
  console.log('wrote', name);
}
