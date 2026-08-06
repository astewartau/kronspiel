// Reads sim/out/iso-{base,a,b,c}.jsonl and writes ../sim_flight.html —
// a themed comparison of the Flucht/Isolation reconciliation options.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DECISIVE = new Set(['isolation', 'palsy', 'hollow']);
const BONE = 1, ASH = -1;

const VARIANTS = [
  { key: 'iso-base', label: 'Baseline', blurb: 'the live game today — the isolation test credits a Flucht escape the move itself forbids' },
  { key: 'iso-a', label: 'Option A', blurb: 'the isolation test demands a legal Flucht (clear, unthreatened path); Flucht can never break a siege' },
  { key: 'iso-b', label: 'Option B', blurb: 'the Flucht leap may cross threatened squares — only the landing must be safe; a besieged Krone can flee' },
  { key: 'iso-c', label: 'Option C', blurb: 'as B, plus Soft Isolation: a Krone saved only by Flucht is forced to flee next turn (the Crown quits the capitol)' },
];

async function load(key) {
  try {
    const txt = await readFile(join(HERE, 'out', `${key}.jsonl`), 'utf8');
    return txt.trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const winnerOf = (g) => (DECISIVE.has(g.type) ? -g.loser : 0); // +1 Bone, -1 Ash, 0 draw
const key2 = (g) => `${g.type}:${g.loser ?? ''}`;

function stats(games, baseBySeed) {
  const n = games.length;
  const types = {};
  let boneWins = 0, ashWins = 0, flSum = 0, flGames = 0, softSum = 0, softGames = 0, diff = 0;
  const plies = [], decPlies = [];
  for (const g of games) {
    types[g.type] = (types[g.type] || 0) + 1;
    const w = winnerOf(g);
    if (w === BONE) boneWins++; else if (w === ASH) ashWins++;
    plies.push(g.plies);
    if (DECISIVE.has(g.type)) decPlies.push(g.plies);
    flSum += g.flucht || 0; if (g.flucht) flGames++;
    softSum += g.soft || 0; if (g.soft) softGames++;
    const bg = baseBySeed && baseBySeed.get(g.seed);
    if (bg && key2(bg) !== key2(g)) diff++;
  }
  const decisive = boneWins + ashWins;
  return {
    n, types, boneWins, ashWins, draws: n - decisive,
    decisivePct: pct(decisive, n), drawPct: pct(n - decisive, n),
    bonePct: pct(boneWins, n), ashPct: pct(ashWins, n),
    medPlies: median(plies), medDecPlies: median(decPlies),
    fluchtPerGame: (flSum / n).toFixed(2), fluchtGamesPct: pct(flGames, n),
    softPerGame: (softSum / n).toFixed(2), softGamesPct: pct(softGames, n),
    diffPct: baseBySeed ? pct(diff, n) : null,
  };
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

const data = {};
for (const v of VARIANTS) data[v.key] = await load(v.key);
const baseBySeed = new Map(data['iso-base'].map((g) => [g.seed, g]));
const S = {};
for (const v of VARIANTS) S[v.key] = stats(data[v.key], v.key === 'iso-base' ? null : baseBySeed);

// ---- console summary ----
console.log('\nvariant   n   decisive%  Bone%  Ash%  draw%  medPly  medDecPly  flucht/g  soft/g  diffFromBase%');
for (const v of VARIANTS) {
  const s = S[v.key];
  console.log(
    v.label.padEnd(9),
    String(s.n).padStart(3),
    String(s.decisivePct).padStart(8) + '%',
    String(s.bonePct).padStart(5) + '%',
    String(s.ashPct).padStart(4) + '%',
    String(s.drawPct).padStart(4) + '%',
    String(s.medPlies).padStart(6),
    String(s.medDecPlies).padStart(9),
    String(s.fluchtPerGame).padStart(8),
    String(s.softPerGame).padStart(6),
    (s.diffPct == null ? '—' : s.diffPct + '%').padStart(13),
  );
}
for (const v of VARIANTS) console.log(v.label.padEnd(9), Object.entries(S[v.key].types).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}:${c}`).join('  '));

// ---- HTML ----
const N = S['iso-base'].n;
const bar = (p, ember) => `<span class="bar"><span class="track"><span class="fill${ember ? ' ember' : ''}" style="width:${p}%"></span></span><span class="val">${p}%</span></span>`;
const allTypes = [...new Set(VARIANTS.flatMap((v) => Object.keys(S[v.key].types)))];
const typeLabel = { isolation: 'Isolation', mutual: 'Mutual Ruin', empty: 'Empty Court', palsy: 'Palsy', frozen: 'Frozen', siege: 'Long Siege', winterdraw: 'Long Winter', cap: 'Unresolved (cap)', hollow: 'Hollow' };

const rows = VARIANTS.map((v) => {
  const s = S[v.key];
  return `<tr>
    <td><span class="vname">${v.label}</span></td>
    <td class="r">${s.decisivePct}%</td>
    <td>${bar(s.bonePct)}</td>
    <td>${bar(s.ashPct, true)}</td>
    <td class="r">${s.drawPct}%</td>
    <td class="r">${s.medPlies}</td>
    <td class="r">${s.medDecPlies}</td>
    <td class="r">${s.fluchtPerGame}</td>
    <td class="r">${v.key === 'iso-c' ? s.softPerGame : '—'}</td>
    <td class="r">${s.diffPct == null ? '—' : s.diffPct + '%'}</td>
  </tr>`;
}).join('\n');

const breakdownRows = allTypes.map((t) => `<tr><td>${typeLabel[t] || t}</td>${VARIANTS.map((v) => `<td class="r">${S[v.key].types[t] || 0}</td>`).join('')}</tr>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kronspiel — The Question of Flight</title>
<meta name="description" content="AI self-play study of four ways to reconcile Die Flucht with Isolation.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;700&family=Cinzel+Decorative:wght@700&family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>♚</text></svg>">
<style>
  :root {
    --bg:#0f0d0b; --bg-2:#16130f; --panel:#1c1813; --panel-edge:#2e2820;
    --ink:#d8cfbe; --ink-dim:#9a8f7c; --gold:#c8a24a; --gold-bright:#e8c96a;
    --gold-pale:#f2dfa0; --gold-deep:#7a5f28; --ember:#b8442f; --ember-soft:#d06a4a; --green:#6f9e5f;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; background:radial-gradient(1200px 700px at 50% -10%, #262015 0%, transparent 60%), radial-gradient(900px 600px at 90% 110%, #1c150d 0%, transparent 55%), var(--bg); color:var(--ink); font-family:"EB Garamond",Georgia,serif; font-size:17.5px; line-height:1.6; }
  .page { max-width:900px; margin:0 auto; padding:40px 22px 70px; }
  header { text-align:center; }
  h1 { font-family:"Cinzel Decorative","Cinzel",serif; font-size:clamp(30px,5.4vw,46px); letter-spacing:0.12em; margin:0; background:linear-gradient(105deg,var(--gold-deep),var(--gold) 28%,var(--gold-pale) 50%,var(--gold) 72%,var(--gold-deep)); -webkit-background-clip:text; background-clip:text; color:transparent; filter:drop-shadow(0 0 18px rgba(200,162,74,0.22)); }
  .report-title { font-family:"Cinzel",serif; font-size:clamp(17px,2.6vw,22px); letter-spacing:0.18em; text-transform:uppercase; color:var(--gold); margin:14px 0 4px; }
  .tagline { font-style:italic; color:var(--ink-dim); margin:2px 0 0; }
  .ornament { display:flex; align-items:center; gap:14px; margin:26px 0; }
  .ornament::before,.ornament::after { content:""; flex:1; height:1px; background:linear-gradient(90deg,transparent,#8a6d2e); }
  .ornament::after { background:linear-gradient(90deg,#8a6d2e,transparent); }
  .ornament span { color:var(--gold); font-size:13px; letter-spacing:6px; }
  h2 { font-family:"Cinzel",serif; font-size:19px; letter-spacing:0.12em; text-transform:uppercase; color:var(--gold); margin:44px 0 12px; }
  h2 .num { color:#8a6d2e; margin-right:10px; }
  p { margin:10px 0; } strong { color:var(--gold-bright); font-weight:600; } em { color:var(--ink); }
  ul,ol { padding-left:26px; } li { margin:6px 0; }
  .opt { color:var(--gold-bright); font-family:"Cinzel",serif; letter-spacing:0.03em; }
  .card { background:linear-gradient(180deg,var(--panel),var(--bg-2)); border:1px solid var(--panel-edge); border-radius:4px; padding:18px 22px; margin:18px 0; position:relative; box-shadow:0 10px 30px rgba(0,0,0,0.3); }
  .card::before { content:""; position:absolute; top:0; left:16px; right:16px; height:1px; background:linear-gradient(90deg,transparent,rgba(200,162,74,0.55),transparent); }
  .card.verdict { border-color:#6a5a2f; }
  blockquote { margin:16px 0; padding:10px 20px; border-left:2px solid var(--gold-deep); font-style:italic; color:var(--ink-dim); }
  blockquote .who { display:block; font-style:normal; font-size:14px; color:#8a7040; margin-top:6px; }
  table { width:100%; border-collapse:collapse; margin:14px 0; font-size:15px; font-variant-numeric:tabular-nums; }
  th { font-family:"Cinzel",serif; font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color:var(--ink-dim); font-weight:600; text-align:left; padding:8px 9px; border-bottom:1px solid #3a3226; }
  td { padding:7px 9px; border-bottom:1px solid #241f17; vertical-align:middle; }
  tr:nth-child(odd) td { background:rgba(255,244,214,0.02); }
  td.r,th.r { text-align:right; }
  .table-scroll { overflow-x:auto; }
  .vname { font-family:"Cinzel",serif; font-size:13.5px; color:var(--gold-bright); white-space:nowrap; }
  .bar { display:flex; align-items:center; gap:8px; min-width:120px; }
  .bar .track { flex:1; height:9px; background:#241f17; border-radius:5px; overflow:hidden; }
  .bar .fill { height:100%; background:linear-gradient(90deg,var(--gold-deep),var(--gold-bright)); }
  .bar .fill.ember { background:linear-gradient(90deg,#6e2a1c,var(--ember-soft)); }
  .bar .val { font-size:13px; color:var(--ink-dim); width:34px; text-align:right; }
  .foot { text-align:center; color:#6e6350; font-size:13.5px; margin-top:40px; }
  a { color:var(--gold-bright); }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1>Kronspiel</h1>
    <div class="report-title">The Question of Flight</div>
    <p class="tagline">Four ways to reconcile Die Flucht with Isolation, weighed in self-play</p>
  </header>
  <div class="ornament"><span>&#10070;</span></div>

  <p>A flaw came to light in an ordinary game: a Krone hemmed in on every side was spared Isolation by an escape he could not lawfully take. The <em>move</em> Die Flucht forbids leaping through a threatened square; the <em>test</em> for Isolation, in the live game, forgets this — and so credits a flight that never was. Four reconciliations were put to the board and played out by the engine against itself.</p>

  <div class="card">
    <p><span class="opt">Baseline</span> — ${VARIANTS[0].blurb}.</p>
    <p><span class="opt">Option A</span> — ${VARIANTS[1].blurb}.</p>
    <p><span class="opt">Option B</span> — ${VARIANTS[2].blurb}.</p>
    <p><span class="opt">Option C</span> — ${VARIANTS[3].blurb}.</p>
  </div>

  <h2><span class="num">I</span> The Field</h2>
  <p>${N} games per rule, each identically seeded across all four, so a difference is the rule's doing and not the dice. The courts were played by the engine at a shallow, uniform search — directional signal, not tournament strength. <strong>diff. from baseline</strong> counts games whose result (winner or draw) the rule changed from the live game.</p>

  <div class="table-scroll">
  <table>
    <thead><tr>
      <th>Rule</th><th class="r">Decisive</th><th>Bone wins</th><th>Ash wins</th>
      <th class="r">Draws</th><th class="r">Med. plies</th><th class="r">Med. decisive</th>
      <th class="r">Flucht / game</th><th class="r">Soft&nbsp;Iso / game</th><th class="r">Diff. vs base</th>
    </tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  </div>

  <h2><span class="num">II</span> How the Games Ended</h2>
  <div class="table-scroll">
  <table>
    <thead><tr><th>Outcome</th>${VARIANTS.map((v) => `<th class="r">${v.label}</th>`).join('')}</tr></thead>
    <tbody>
${breakdownRows}
    </tbody>
  </table>
  </div>

  <h2><span class="num">III</span> Counsel</h2>
  <div class="card verdict">
    <p><strong>The commission favours Option C.</strong></p>
    <p><span class="opt">Baseline</span> is discarded on sight — it is the flaw itself, deciding games on flights that cannot lawfully be flown. Among the three honest reconciliations the board stays decisive under all, and the first-mover balance survives under two — but not the third.</p>
    <p><span class="opt">Option B</span>, which lets a Krone vault a besieging ring, hands the Bone Court (who moves first) a marked edge — <strong>${S['iso-b'].bonePct}% to ${S['iso-b'].ashPct}%</strong> against a near-even baseline. The freedom to leap clear of a siege rewards the court that strikes first, and the scales tip.</p>
    <p><span class="opt">Option A</span> is the safe hand: perfectly even (<strong>${S['iso-a'].bonePct}% / ${S['iso-a'].ashPct}%</strong>) and a touch crisper (median ${S['iso-a'].medPlies} plies vs ${S['iso-base'].medPlies}). But it quietly retires Die Flucht as any answer to encirclement — the leap is used scarcely more than today (${S['iso-a'].fluchtPerGame} vs ${S['iso-base'].fluchtPerGame} per game). Correct, and a little colourless.</p>
    <p><span class="opt">Option C</span> — B with <em>Soft Isolation</em> — keeps Die Flucht a living escape (played <strong>${S['iso-c'].fluchtPerGame}</strong> times a game, near twice the baseline's ${S['iso-base'].fluchtPerGame}), and its forced flight comes into play in roughly <strong>one game in ${Math.max(1, Math.round(1 / (S['iso-c'].softGamesPct / 100)))}</strong> (${S['iso-c'].softGamesPct}% of games). Yet because the flight is <em>compelled</em> — spending the once-only leap and surrendering the tempo — it pulls the balance back to near-even (<strong>${S['iso-c'].bonePct}% / ${S['iso-c'].ashPct}%</strong>). It preserves the flavour sought — the Crown quitting the capitol for the countryside — without the tilt Option B introduces.</p>
    <blockquote>The court that would not fall must run; and having run, has spent its running.
      <span class="who">— on the Soft Isolation</span></blockquote>
    <p class="meh" style="color:var(--ink-dim);font-size:14.5px">A caveat of method: the courts here played at a shallow, uniform search, which makes nearly every game decisive — so the draw rates and exact lengths read harsher than a human table would. The <em>balance</em> figures (Bone vs Ash), paired seed for seed, are the firmest signal, and they speak plainly for C.</p>
  </div>

  <p class="foot">Generated from AI self-play · ${N} games per rule · seeds paired across variants.<br>
  <a href="index.html">&#10094; Return to the game</a></p>
</div>
</body>
</html>`;

await writeFile(join(ROOT, 'sim_flight.html'), html);
console.log('\nwrote sim_flight.html');
