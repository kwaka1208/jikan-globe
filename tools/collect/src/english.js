// npm run english
//
// 英語表記用のデータを app/data/en/ に書き出す。npm run build のあとに実行する
// （build は app/data/ を作り直すので、build のたびにこれもやり直す）。
//   en/index-tier12.json      tier 1〜2 の名前と場所 { id: [title, place] }
//   en/chunks/<from>_<to>.json  tier 3〜4 の名前と場所（日本語の chunks と同じファイル名・同じ範囲）
//   en/text/<from>_<to>.json    説明文 { id: { x, xs, w } }（日本語の text と同じ範囲）
// 名前・場所・説明は Wikidata の英語ラベルと英語の説明（CC0）、記事は英語版ウィキペディアへのリンク。
// 種データ（seed）は seed/curated-seed.json の title_en / place_en / text_en（人が書いたもの）を使う。
// 英語の名前がないものは書かない（アプリは日本語の名前を出す）。場所がないものは null（アプリは国の英語名を出す）。
// Wikidata への問い合わせは QLever（sources.yaml の list_sparql）。結果は cache/sparql にたまる。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from './lib/config.js';
import { createSparql, qid, val } from './lib/wdqs.js';
import { parseArgs } from './lib/args.js';

const DATA = path.join(ROOT_DIR, 'app/data');
const OUT = path.join(DATA, 'en');
const BATCH = 400;
const args = parseArgs(process.argv.slice(2));
const { client } = loadConfig('sources');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const meta = readJson(path.join(DATA, 'meta.json'));
const files = [meta.index.file, ...meta.chunks.map((c) => c.file)];
const rowsByFile = new Map(files.map((f) => [f, readJson(path.join(DATA, f))]));
const all = [...rowsByFile.values()].flat();

// 種データの英語（日本語の名前で突き合わせる。QID に紐づいた種データも名前は種データのもの）
const seeds = readJson(path.join(ROOT_DIR, 'seed/curated-seed.json')).events;
const seedByTitle = new Map(seeds.map((s) => [s.title, s]));

const sparql = createSparql({
  endpoint: client.list_sparql.endpoint,
  engine: client.list_sparql.engine,
  userAgent: client.user_agent,
  maxRetries: client.max_retries,
  refresh: !!args.refresh,
  log: (m) => console.log(m),
});
const values = (ids) => ids.map((i) => `wd:${i}`).join(' ');

// 名前（en → mul の順）、説明（en）、英語版ウィキペディアの記事
const nameQuery = (ids) => `SELECT ?item ?en ?mul ?desc ?enwiki WHERE {
  VALUES ?item { ${values(ids)} }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?mul FILTER(LANG(?mul) = "mul") }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?enwiki schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
}`;
// 場所：P276（場所）・P19（出生地）・P131（行政区画）・P17（国）の英語ラベル。掛け算で増えないよう UNION で取る
const placeQuery = (ids) => `SELECT ?item ?kind ?label WHERE {
  VALUES ?item { ${values(ids)} }
  { ?item wdt:P276 ?x . BIND("P276" AS ?kind) }
  UNION { ?item wdt:P19 ?x . BIND("P19" AS ?kind) }
  UNION { ?item wdt:P131 ?x . BIND("P131" AS ?kind) }
  UNION { ?item wdt:P17 ?x . BIND("P17" AS ?kind) }
  ?x rdfs:label ?label FILTER(LANG(?label) = "en")
}`;

async function fetchAll(ids) {
  const info = new Map(ids.map((i) => [i, { places: {} }]));
  for (let i = 0; i < ids.length; i += BATCH) {
    const part = ids.slice(i, i + BATCH);
    console.log(`${i + part.length}/${ids.length}`);
    for (const b of await sparql.query(nameQuery(part))) {
      const o = info.get(qid(val(b, 'item')));
      o.en ??= val(b, 'en');
      o.mul ??= val(b, 'mul');
      o.desc ??= val(b, 'desc');
      o.enwiki ??= val(b, 'enwiki');
    }
    for (const b of await sparql.query(placeQuery(part))) {
      const o = info.get(qid(val(b, 'item')));
      const k = val(b, 'kind');
      (o.places[k] ??= []).push(val(b, 'label'));
    }
  }
  return info;
}

// 説明の1文目を大文字で始める（Wikidata の説明は小文字で始まる）
const cap = (s) => s && s[0].toUpperCase() + s.slice(1);

function entryOf(e, info) {
  const seed = e.src === 'seed' ? seedByTitle.get(e.t) : null;
  const w = info?.enwiki || null;
  if (seed?.title_en) {
    return { t: seed.title_en, p: seed.place_en || null, x: seed.text_en ? { x: seed.text_en, xs: 'human', ...(w && { w }) } : null };
  }
  if (!info) return null;
  const t = info.en || info.mul;
  if (!t) return null;
  const pl = info.places;
  const p = (e.cat === 'people' ? pl.P19 : pl.P276)?.[0] || pl.P131?.[0] || pl.P17?.[0] || null;
  const x = info.desc || w ? { x: cap(info.desc) || null, xs: 'wikidata', ...(w && { w }) } : null;
  return { t, p: p === t ? null : p, x };
}

// 日本語の text と同じ範囲で分ける（アプリは meta.text の範囲からファイル名を決める）
function textFileOf(y) {
  return meta.text.find((c) => y >= c.from && y <= c.to)?.file;
}

async function main() {
  const ids = [...new Set(all.filter((e) => /^Q\d+$/.test(e.id)).map((e) => e.id))];
  const info = await fetchAll(ids);

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'chunks'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'text'), { recursive: true });

  const texts = new Map();
  let named = 0, described = 0;
  for (const [file, rows] of rowsByFile) {
    const names = {};
    for (const e of rows) {
      const en = entryOf(e, info.get(e.id));
      if (!en) continue;
      names[e.id] = en.p ? [en.t, en.p] : [en.t];
      named++;
      if (!en.x) continue;
      const tf = textFileOf(e.y);
      if (!tf) continue;
      (texts.get(tf) || texts.set(tf, {}).get(tf))[e.id] = en.x;
      described++;
    }
    fs.writeFileSync(path.join(OUT, file), JSON.stringify(names));
  }
  for (const c of meta.text) fs.writeFileSync(path.join(OUT, c.file), JSON.stringify(texts.get(c.file) || {}));

  console.log(`app/data/en/ に書き出しました：名前 ${named}/${all.length}件、説明 ${described}件`);
  if (sparql.liveCount === 0) console.log('（すべてキャッシュから。取り直すときは --refresh）');
}

main().catch((e) => { console.error(e); process.exit(1); });
