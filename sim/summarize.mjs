// Aggregates sim/out/*.jsonl into a per-variant table.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');
const DECISIVE = new Set(['isolation', 'palsy', 'hollow']);
const ORDER = ['baseline', 'frozenloss', 'hollow', 'smallhammers', 'loose', 'loosetruce', 'winter'];

const rows = [];
for (const f of await readdir(OUT)) {
  if (!f.endsWith('.jsonl')) continue;
  const games = (await readFile(join(OUT, f), 'utf8')).trim().split('\n').map(JSON.parse);
  const name = f.replace('.jsonl', '');
  const n = games.length;
  const by = {};
  for (const g of games) by[g.type] = (by[g.type] || 0) + 1;
  const decisive = games.filter((g) => DECISIVE.has(g.type));
  const plies = games.map((g) => g.plies).sort((a, b) => a - b);
  const dPlies = decisive.map((g) => g.plies).sort((a, b) => a - b);
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : NaN);
  rows.push({
    name, n,
    'decisive%': Math.round((decisive.length / n) * 100),
    breakdown: Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '),
    'med plies': med(plies),
    'med decisive plies': med(dPlies),
    'truce saves': games.reduce((s, g) => s + (g.truceSaves || 0), 0) || undefined,
    'winter claimed': games.reduce((s, g) => s + (g.claimed || 0), 0) || undefined,
  });
}
const baseOf = (n) => n.replace(/-deep$/, '');
rows.sort((a, b) =>
  (a.name.endsWith('-deep') ? 1 : 0) - (b.name.endsWith('-deep') ? 1 : 0) ||
  ORDER.indexOf(baseOf(a.name)) - ORDER.indexOf(baseOf(b.name)));
console.table(rows.map(({ breakdown, ...r }) => r));
for (const r of rows) console.log(r.name.padEnd(20), r.breakdown);
