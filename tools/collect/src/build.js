// npm run build
//
// work/scored.jsonl にレビューの判断（review/decisions.json）を当て、アプリが読む app/data/ を書き出す。
//   meta.json          生成日時、件数、チャンク一覧、カテゴリ、出典とライセンス
//   index-tier12.json  tier 1〜2 の全件（起動時に読む）
//   chunks/<from>_<to>.json  tier 3〜4 を時代別に分けたもの（必要になったら読む）
//   text/<from>_<to>.json    説明文（タップされたら読む）
// チャンクは1ファイルが gzip 後でおおむね200KB以下になるよう、年の区切りで自動的に分ける。
// app/data/ は毎回作り直す（手で編集しない）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig, WORK_DIR, ROOT_DIR } from './lib/config.js';
import { readJsonl } from './lib/jsonl.js';
import { chooseText, applyDecision, loadDecisions } from './lib/select.js';

const OUT = path.join(ROOT_DIR, 'app/data');
const CHUNK_GZ_LIMIT = 200 * 1024;
const sources = loadConfig('sources');

const gzSize = (s) => zlib.gzipSync(s, { level: 9 }).length;

// 1件をアプリ用の短いキーに（HANDOFF 7章）
function toShort(e) {
  const o = {
    id: e.id,
    y: e.year,
    ye: e.year_end ?? null,
    a: e.approx ? 1 : 0,
    la: e.lat,
    lo: e.lng,
    cs: e.coord_source,
    t: e.title,
    p: e.place || null,
    c: e.country,
    cat: e.category,
    j: e.japan,
    tr: e.tier,
    src: e.src,
  };
  if (e.reviewed) o.rv = 1; // 人が確認済み（#all の表示切り替えに使う）
  if (e.japan_party) o.jpp = 1; // 日本が当事者（場所は日本の外でも「そのころ日本では」に出す）
  return o;
}

// 年の順に並んだ行を、gzip 後の大きさが limit 以下になるよう年の区切りで分ける。
// 同じ年のものは同じファイルに入れる（アプリが年からファイルを決められるように）
function splitByYear(rows, toJson, limit) {
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  // まず生のサイズで大まかに分け（gzip はおよそ 1/6 になる）、超えたら半分に割る
  const roughLimit = limit * 6;
  let size = 0;
  for (let i = 0; i < rows.length; i++) {
    const s = JSON.stringify(rows[i]).length;
    if (size + s > roughLimit && cur.length && rows[i].year !== cur.at(-1).year) { flush(); size = 0; }
    cur.push(rows[i]);
    size += s;
  }
  flush();
  const out = [];
  const fit = (g) => {
    if (gzSize(toJson(g)) <= limit || g[0].year === g.at(-1).year) return out.push(g);
    // 年の境目で半分に割る
    let mid = Math.floor(g.length / 2);
    while (mid < g.length && g[mid].year === g[mid - 1].year) mid++;
    if (mid >= g.length) { mid = Math.floor(g.length / 2); while (mid > 0 && g[mid].year === g[mid - 1].year) mid--; }
    if (mid <= 0) return out.push(g);
    fit(g.slice(0, mid)); fit(g.slice(mid));
  };
  groups.forEach(fit);
  // 範囲は「この年から次のファイルの前の年まで」とし、隙間なくつなぐ
  return out.map((g, i) => ({
    from: g[0].year,
    to: i === out.length - 1 ? g.at(-1).year : out[i + 1][0].year - 1,
    rows: g,
  }));
}

const fileName = (from, to) => `${from}_${to}.json`;

function main() {
  const decisions = loadDecisions();
  const scored = readJsonl(path.join(WORK_DIR, 'scored.jsonl'));

  const events = [];
  let excludedByReview = 0;
  for (const e0 of scored) {
    const e = applyDecision(e0, decisions[e0.id]);
    if (!e) { excludedByReview++; continue; }
    const { text, source } = chooseText(e, decisions[e0.id]);
    e.text_final = text;
    e.text_source_final = source;
    events.push(e);
  }
  events.sort((a, b) => a.year - b.year || a.tier - b.tier || (b.score ?? 0) - (a.score ?? 0));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'text'), { recursive: true });

  // 起動時に読む索引（tier 1〜2）
  const t12 = events.filter((e) => e.tier <= 2);
  const indexJson = JSON.stringify(t12.map(toShort));
  fs.writeFileSync(path.join(OUT, 'index-tier12.json'), indexJson);

  // tier 3〜4 のチャンク
  const t34 = events.filter((e) => e.tier >= 3);
  const chunkJson = (g) => JSON.stringify(g.map(toShort));
  const chunks = splitByYear(t34, chunkJson, CHUNK_GZ_LIMIT).map((c) => {
    const json = chunkJson(c.rows);
    const file = `chunks/${fileName(c.from, c.to)}`;
    fs.writeFileSync(path.join(OUT, file), json);
    return { file, from: c.from, to: c.to, count: c.rows.length, gz: gzSize(json) };
  });

  // 説明文（全 tier）
  const textEntry = (e) => {
    const o = { x: e.text_final, xs: e.text_source_final };
    if (e.wikipedia_url) o.w = e.wikipedia_url;
    return o;
  };
  const withText = events.filter((e) => e.text_final);
  const textJson = (g) => JSON.stringify(Object.fromEntries(g.map((e) => [e.id, textEntry(e)])));
  const texts = splitByYear(withText, textJson, CHUNK_GZ_LIMIT).map((c) => {
    const json = textJson(c.rows);
    const file = `text/${fileName(c.from, c.to)}`;
    fs.writeFileSync(path.join(OUT, file), json);
    return { file, from: c.from, to: c.to, count: c.rows.length, gz: gzSize(json) };
  });

  const count = (f) => events.filter(f).length;
  const byTier = Object.fromEntries([1, 2, 3, 4].map((t) => [t, count((e) => e.tier === t)]));
  const byCategory = {};
  for (const e of events) byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  const textSources = {};
  for (const e of withText) textSources[e.text_source_final] = (textSources[e.text_source_final] || 0) + 1;

  const meta = {
    generated_at: new Date().toISOString(),
    count: events.length,
    by_tier: byTier,
    by_category: byCategory,
    text_sources: textSources,
    years: { min: events[0]?.year ?? null, max: events.at(-1)?.year ?? null },
    index: { file: 'index-tier12.json', count: t12.length, gz: gzSize(indexJson) },
    chunks,
    text: texts,
    categories: Object.fromEntries(
      Object.entries(sources.categories).map(([k, c]) => [k, { label: c.label, label_en: c.label_en, hidden: !!c.hidden_by_default }]),
    ),
    sources: [
      { name: 'Wikidata', url: 'https://www.wikidata.org/', license: 'CC0 1.0', note: 'できごとの年・場所・名前' },
      { name: 'ウィキペディア日本語版', url: 'https://ja.wikipedia.org/', license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/deed.ja', note: '説明文（xs が wikipedia / ai-draft のもの）。各できごとの w が元の記事' },
      { name: 'Natural Earth（world-atlas）', url: 'https://www.naturalearthdata.com/', license: 'Public Domain', note: '国境データ' },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 1));

  console.log(`app/data/ に書き出しました：${events.length}件（レビューで除外 ${excludedByReview}件）`);
  console.log('  tier：', byTier);
  console.log('  カテゴリ：', byCategory);
  console.log('  説明文：', textSources, `なし ${events.length - withText.length}件`);
  console.log(`  index-tier12.json：${t12.length}件、gzip ${(meta.index.gz / 1024).toFixed(1)}KB`);
  console.log(`  chunks：${chunks.length}ファイル（最大 gzip ${(Math.max(0, ...chunks.map((c) => c.gz)) / 1024).toFixed(1)}KB）`);
  console.log(`  text：${texts.length}ファイル（最大 gzip ${(Math.max(0, ...texts.map((c) => c.gz)) / 1024).toFixed(1)}KB）`);
}

main();
