// npm run report
//
// 地域×時代ごとの件数、カテゴリ別の件数、除外の件数を表で出す。
// 画面に出すほか、work/report.md にも書き出す（表を見て、極端に空の区画がないかを確かめる）。
// セルの値は「tier1〜2 の件数 / 全件数」。日本国内（japan: in）は地域とは別の列にする。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, WORK_DIR } from './lib/config.js';
import { readJsonl } from './lib/jsonl.js';

const regions = loadConfig('regions').regions;
const scoring = loadConfig('scoring');
const scored = readJsonl(path.join(WORK_DIR, 'scored.jsonl'));
const excluded = readJsonl(path.join(WORK_DIR, 'excluded.jsonl'));

const eraKeys = [];
for (const e of scoring.eras) for (let y = e.from; y < e.to; y += e.step) eraKeys.push(`${y}_${Math.min(y + e.step, e.to)}`);
const allEras = [`<${scoring.eras[0].from}`, ...eraKeys, `>=${scoring.eras.at(-1).to}`];
const cols = [...Object.keys(regions).map((k) => ({ key: k, label: regions[k].label })), { key: 'japan', label: '日本（国内）' }, { key: 'unknown', label: '不明' }];

const colOf = (e) => (e.japan === 'in' ? 'japan' : regions[e.region] ? e.region : 'unknown');
const cell = new Map();
for (const e of scored) {
  const k = `${e.era}|${colOf(e)}`;
  const c = cell.get(k) || cell.set(k, { t12: 0, all: 0 }).get(k);
  c.all++;
  if (e.tier <= 2) c.t12++;
}

const fmtEra = (k) => {
  const m = k.match(/^(-?\d+)_(-?\d+)$/);
  if (!m) return k;
  const y = (n) => (n < 0 ? `前${-n}` : String(n));
  return `${y(Number(m[1]))}〜${y(Number(m[2]) - 1)}`;
};

const lines = [];
lines.push(`# じかんの地球儀 データの件数（${new Date().toISOString().slice(0, 10)}）`, '');
lines.push(`採用 ${scored.length}件 / 除外 ${excluded.length}件`, '');
lines.push('## 地域×時代（tier1〜2 / 全件。空欄は0件）', '');
lines.push(`| 時代 | ${cols.map((c) => c.label).join(' | ')} |`);
lines.push(`|---|${cols.map(() => '---:').join('|')}|`);
const used = allEras.filter((era) => cols.some((c) => cell.get(`${era}|${c.key}`)));
for (const era of used) {
  lines.push(`| ${fmtEra(era)} | ${cols.map((c) => { const v = cell.get(`${era}|${c.key}`); return v ? `${v.t12} / ${v.all}` : ''; }).join(' | ')} |`);
}
const colTotals = cols.map((c) => {
  let t12 = 0, all = 0;
  for (const era of allEras) { const v = cell.get(`${era}|${c.key}`); if (v) { t12 += v.t12; all += v.all; } }
  return `**${t12} / ${all}**`;
});
lines.push(`| **合計** | ${colTotals.join(' | ')} |`, '');

const tally = (rows, f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
const table = (title, obj, head) => {
  lines.push(`## ${title}`, '', `| ${head} | 件数 |`, '|---|---:|');
  for (const [k, v] of Object.entries(obj).sort((a, b) => b[1] - a[1])) lines.push(`| ${k} | ${v} |`);
  lines.push('');
};
table('tier 別', tally(scored, (e) => `tier ${e.tier}`), 'tier');
table('カテゴリ別', tally(scored, (e) => e.category), 'カテゴリ');
table('日本との関わり', tally(scored, (e) => e.japan), 'japan');
table('除外の理由', tally(excluded, (e) => e.reason.replace(/:.*/, '')), '理由');
table('除外の内訳（クラス・語）', tally(excluded.filter((e) => e.reason.includes(':')), (e) => e.reason), '理由');

const md = lines.join('\n');
fs.writeFileSync(path.join(WORK_DIR, 'report.md'), md + '\n');
console.log(md);
console.log(`\n（work/report.md にも書き出しました）`);
