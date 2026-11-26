// npm run review:export … review/candidates.csv を書き出す（UTF-8 BOM付き。Googleスプレッドシートで開ける）
// npm run review:import [-- --file=path/to.csv] … 編集したCSVの判断を review/decisions.json に取り込む
//
// 判断はIDで紐づけるので、データを取り直しても消えない。decisions.json は git で管理する。
// 書き出しの対象（HANDOFF 6.6）：tier 1〜2 の未確認分、japan: link の候補、重複の疑い、
// 除外ルールにぎりぎり当たったもの（borderline・説明文の差し替え）、年の値の幅が大きいもの。
// すでに判断があるものは、その判断を入れた状態で書き出す。
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { WORK_DIR, REVIEW_DIR } from './lib/config.js';
import { readJsonl } from './lib/jsonl.js';
import { chooseText, loadDecisions, DECISIONS_FILE } from './lib/select.js';
import { parseArgs } from './lib/args.js';

const CSV_FILE = path.join(REVIEW_DIR, 'candidates.csv');
const COLUMNS = ['id', 'year', 'approx', 'title', 'place', 'country', 'category', 'tier', 'japan', 'text', 'text_source', 'wikipedia_url',
  'decision', 'text_final', 'japan_final', 'tier_final', 'note', 'flags'];
const EDITABLE = ['decision', 'text_final', 'japan_final', 'tier_final', 'note'];
const ALLOWED = {
  decision: ['', 'include', 'exclude'],
  japan_final: ['', 'in', 'link', 'none'],
  tier_final: ['', '1', '2', '3', '4'],
};

function reasonsFor(e) {
  const r = [];
  if (e.tier <= 2 && !e.reviewed) r.push(`tier${e.tier}`);
  for (const f of e.review_flags || []) r.push(f);
  return r;
}

function exportCsv() {
  const scored = readJsonl(path.join(WORK_DIR, 'scored.jsonl'));
  const decisions = loadDecisions();
  const rows = [];
  for (const e of scored) {
    const reasons = reasonsFor(e);
    if (!reasons.length && !decisions[e.id]) continue;
    const d = decisions[e.id] || {};
    const { text, source } = chooseText(e, null);
    rows.push({
      id: e.id, year: e.year, approx: e.approx ? 1 : '', title: e.title, place: e.place, country: e.country,
      category: e.category, tier: e.tier, japan: e.japan, text, text_source: source, wikipedia_url: e.wikipedia_url,
      decision: d.decision || '', text_final: d.text_final || '', japan_final: d.japan_final || '',
      tier_final: d.tier_final || '', note: d.note || '', flags: reasons.join(' '),
    });
  }
  // 見やすさのため：判断がまだのもの → tier → 年の順
  rows.sort((a, b) => (a.decision ? 1 : 0) - (b.decision ? 1 : 0) || a.tier - b.tier || a.year - b.year);
  fs.mkdirSync(REVIEW_DIR, { recursive: true });
  fs.writeFileSync(CSV_FILE, '﻿' + stringify(rows, { header: true, columns: COLUMNS }));
  const count = (p) => rows.filter(p).length;
  console.log(`review/candidates.csv：${rows.length}件（判断済み ${count((r) => r.decision)}件）`);
  console.log(`  tier1〜2 未確認 ${count((r) => /\btier[12]\b/.test(r.flags))} / japan_link ${count((r) => r.flags.includes('japan_link'))} / 重複の疑い ${count((r) => r.flags.includes('dup_suspect'))} / borderline ${count((r) => r.flags.includes('borderline'))} / 説明文差し替え ${count((r) => r.flags.includes('text_removed'))} / 年の幅 ${count((r) => r.flags.includes('date_spread'))}`);
}

function importCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = parse(text, { columns: true, skip_empty_lines: true });
  const decisions = loadDecisions();
  let updated = 0;
  const errors = [];
  for (const r of rows) {
    const d = {};
    for (const k of EDITABLE) {
      const v = String(r[k] ?? '').trim();
      if (ALLOWED[k] && !ALLOWED[k].includes(v)) errors.push(`${r.id} の ${k} が「${v}」です（使える値：${ALLOWED[k].filter(Boolean).join(' / ')}）`);
      else if (v) d[k] = v;
    }
    if (!Object.keys(d).length) continue;
    const prev = decisions[r.id] || {};
    const same = EDITABLE.every((k) => (prev[k] || '') === (d[k] || ''));
    if (same) continue;
    decisions[r.id] = { ...d, title: r.title, updated_at: new Date().toISOString() };
    updated++;
  }
  if (errors.length) {
    console.error('取り込めない値がありました。CSVを直してからもう一度実行してください：');
    errors.forEach((e) => console.error('  ' + e));
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(decisions).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(DECISIONS_FILE, JSON.stringify(sorted, null, 1) + '\n');
  console.log(`review/decisions.json：${updated}件を更新（合計 ${Object.keys(sorted).length}件）`);
}

const args = parseArgs();
const cmd = args._[0];
if (cmd === 'export') exportCsv();
else if (cmd === 'import') importCsv(args.file && args.file !== true ? args.file : CSV_FILE);
else { console.error('使い方：review.js export | import [--file=...]'); process.exit(1); }
