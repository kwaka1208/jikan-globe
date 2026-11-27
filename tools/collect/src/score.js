// npm run score
//
// work/events.jsonl と種データを合わせ、除外・重複の整理・スコア・tier の割り当てをする。
// - 種データ（seed/curated-seed.json）は常に tier 1。Wikidataの同じできごとと重なったら種データを採り、QIDだけ紐づける
// - 子ども向けの除外（config/filters.yaml）。除外したものは work/excluded.jsonl に理由付きで残す
// - 地域×時代の区画ごとに順番に配って、偏りを補正する（config/scoring.yaml、regions.yaml）
//   人物は別の枠で配る。tier によっては1カテゴリが占める割合に上限がある
// - レビューに出すべき目印を review_flags に付ける
// 出力：work/scored.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CACHE_DIR, WORK_DIR, ROOT_DIR } from './lib/config.js';
import { readJsonl, writeJsonl } from './lib/jsonl.js';
import { titleSimilarity, distanceKm } from './lib/text.js';

const filters = loadConfig('filters');
const scoring = loadConfig('scoring');
const regionsCfg = loadConfig('regions').regions;
const filterClasses = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'wikidata', '_filter_classes.json'), 'utf8'));

const regionOf = new Map();
for (const [key, r] of Object.entries(regionsCfg)) for (const c of r.countries) regionOf.set(String(c), key);

// ---- 時代の区切り ----
const eraBounds = [];
for (const e of scoring.eras) for (let y = e.from; y < e.to; y += e.step) eraBounds.push([y, Math.min(y + e.step, e.to)]);
export function eraOf(year) {
  if (year < eraBounds[0][0]) return `<${eraBounds[0][0]}`;
  const b = eraBounds.find(([a, z]) => year >= a && year < z);
  return b ? `${b[0]}_${b[1]}` : `>=${eraBounds.at(-1)[1]}`;
}

// ---- 除外 ----
const findWord = (text, words) => (text ? (words || []).find((w) => text.includes(w)) : undefined);

function applyFilters(e) {
  // ローマ字だけのタイトル（normalize で日本語版の記事名に置き換えられなかったもの）も外す
  if (!filters.labels?.allow_english_only && !/[぀-ヿ㐀-鿿]/.test(e.title || '')) return 'no_ja_label';
  if (filters.max_year != null && e.year > filters.max_year) return 'future';
  const cls = (e.types || []).find((t) => filterClasses[t]);
  if (cls) return `class:${filterClasses[cls]}`;
  const w = findWord(e.title, filters.exclude_words) || findWord(e.desc_ja, filters.exclude_words);
  if (w) return `word:${w}`;
  return null;
}

function addFlags(e) {
  const flags = [];
  const b = findWord(e.title, filters.borderline_words) || findWord(e.desc_ja, filters.borderline_words);
  if (b) flags.push(`borderline:${b}`);
  const t = findWord(e.wikipedia_text, filters.text_exclude_words);
  if (t) {
    e.wikipedia_text = null; // 残酷な描写を説明文に使わない
    flags.push(`text_removed:${t}`);
  }
  if (e.japan_candidates?.length) flags.push(`japan_link:${e.japan_candidates.join('+')}`);
  if (e.date_spread >= 100) flags.push(`date_spread:${e.date_spread}`);
  if (e.vague_location) flags.push('vague_location');
  return flags;
}

// ---- スコア ----
function score(e) {
  const w = scoring.weights;
  const base =
    Math.log10(1 + (e.sitelinks || 0)) * w.sitelinks +
    (e.jawiki ? w.jawiki : 0) +
    Math.log10(1 + (e.wikipedia_length || 0)) * w.wikipedia_length;
  const cw = scoring.category_weight[e.category] ?? 1;
  const cf = scoring.coord_factor[e.coord_source] ?? 1;
  return Math.round(base * cw * cf * 1000) / 1000;
}

// ---- 種データとの重複 ----
function matchSeeds(seeds, events) {
  const d = scoring.dedupe;
  const byTitle = new Map();
  for (const e of events) {
    for (const t of [e.title, e.jawiki]) if (t) (byTitle.get(t) || byTitle.set(t, []).get(t)).push(e);
  }
  const matched = new Map(); // seed.id → event
  const suspects = [];        // { seed, event, sim }
  for (const s of seeds) {
    const exact = (byTitle.get(s.title) || []).filter((e) => Math.abs(e.year - s.year) <= Math.max(d.year_tolerance, s.approx ? 50 : 0));
    if (exact.length) {
      matched.set(s.id, exact.sort((a, b) => b.sitelinks - a.sitelinks)[0]);
      continue;
    }
    let best = null;
    for (const e of events) {
      if (Math.abs(e.year - s.year) > d.year_tolerance) continue;
      if (distanceKm(s.lat, s.lng, e.lat, e.lng) > d.distance_km) continue;
      const sim = titleSimilarity(s.title, e.title || '');
      if (sim >= d.suspect_similarity && (!best || sim > best.sim)) best = { event: e, sim };
    }
    if (best && best.sim >= d.title_similarity) matched.set(s.id, best.event);
    else if (best) suspects.push({ seed: s, event: best.event, sim: Math.round(best.sim * 100) / 100 });
  }
  return { matched, suspects };
}

function seedToEvent(s, match) {
  return {
    id: match ? match.id : s.id,
    qid: match?.qid || null,
    seed_id: s.id,
    category: s.category || match?.category || 'other',
    year: s.year,
    year_end: s.year_end ?? null,
    approx: !!s.approx,
    lat: s.lat,
    lng: s.lng,
    coord_source: 'self',
    country: s.country,
    place: s.place,
    title: s.title,
    text: s.text,
    text_source: s.text_source || 'human',
    sitelinks: match?.sitelinks || 0,
    jawiki: match?.jawiki || null,
    wikipedia_url: match?.wikipedia_url || null,
    wikipedia_text: match?.wikipedia_text || null,
    desc_ja: match?.desc_ja || null,
    japan: s.japan,
    japan_party: !!s.japan_party, // 場所は日本の外でも、日本が当事者のできごと
    japan_candidates: [],
    reviewed: s.reviewed !== false,
    src: 'seed',
    tier: 1,
  };
}

// ---- tier の割り当て（区画ごとに順番に配る） ----
function assignTiers(pool, cellOf, targets, fixedCount = {}) {
  const cells = new Map();
  for (const e of pool) {
    const k = cellOf(e);
    (cells.get(k) || cells.set(k, []).get(k)).push(e);
  }
  for (const list of cells.values()) list.sort((a, b) => b.score - a.score);
  const assigned = {};
  for (const tier of [1, 2, 3]) {
    const { target, min_score, max_share_per_category: share } = targets[tier];
    const cap = share != null ? Math.ceil(target * share) : Infinity;
    const perCat = {};
    // 区画の中で、上限に達していないカテゴリのうちスコアがいちばん高いもの（並べ替え済みなので最初に見つかったもの）
    const headIndex = (l) => (cap === Infinity ? (l.length ? 0 : -1) : l.findIndex((e) => (perCat[e.category] || 0) < cap));
    let count = fixedCount[tier] || 0;
    let progressed = true;
    while (count < target && progressed) {
      progressed = false;
      // その回にまだ候補が残っている区画を、先頭のスコアが高い順に回る
      const round = [];
      for (const l of cells.values()) {
        const i = headIndex(l);
        if (i >= 0 && l[i].score >= min_score) round.push(l);
      }
      round.sort((a, b) => b[headIndex(b)].score - a[headIndex(a)].score);
      for (const list of round) {
        if (count >= target) break;
        const i = headIndex(list); // 同じ回で上限に達したカテゴリは飛ばす
        if (i < 0 || list[i].score < min_score) continue;
        const [e] = list.splice(i, 1);
        e.tier = tier;
        perCat[e.category] = (perCat[e.category] || 0) + 1;
        count++;
        progressed = true;
      }
    }
    assigned[tier] = count;
  }
  for (const list of cells.values()) for (const e of list) e.tier = 4;
  assigned[4] = [...cells.values()].reduce((n, l) => n + l.length, 0);
  return assigned;
}

function main() {
  const events = readJsonl(path.join(WORK_DIR, 'events.jsonl'));
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'seed/curated-seed.json'), 'utf8')).events;
  const excluded = readJsonl(path.join(WORK_DIR, 'excluded-normalize.jsonl'));

  // 1. 除外
  const kept = [];
  for (const e of events) {
    const reason = applyFilters(e);
    if (reason) excluded.push({ id: e.id, category: e.category, reason, title: e.title || e.title_en, year: e.year, country: e.country });
    else kept.push(e);
  }

  // 2. 種データとの重複
  const { matched, suspects } = matchSeeds(seeds, kept);
  const mergedIds = new Set([...matched.values()].map((e) => e.id));
  const seedEvents = seeds.map((s) => seedToEvent(s, matched.get(s.id)));
  const suspectBy = new Map(suspects.map((x) => [x.event.id, x]));

  // 3. スコアと目印
  const auto = kept.filter((e) => !mergedIds.has(e.id));
  for (const e of auto) {
    e.src = 'wikidata';
    e.score = score(e);
    e.region = regionOf.get(e.country) || 'unknown';
    e.era = eraOf(e.year);
    e.review_flags = addFlags(e);
    const sus = suspectBy.get(e.id);
    if (sus) e.review_flags.push(`dup_suspect:${sus.seed.id}:${sus.sim}`);
  }
  for (const e of seedEvents) {
    e.score = 99;
    e.region = regionOf.get(e.country) || 'unknown';
    e.era = eraOf(e.year);
    e.review_flags = [];
  }

  // 4. tier。種データは tier 1 として枠に数える
  const isJapan = (e) => e.japan === 'in';
  const seedT1 = { world: seedEvents.filter((e) => !isJapan(e)).length, japan: seedEvents.filter(isJapan).length };
  // 人物は初期非表示なので、ほかのできごととは別の枠で配る（scoring.yaml の people）
  const isPeople = (e) => e.category === 'people';
  const others = auto.filter((e) => !isPeople(e));
  const people = auto.filter(isPeople);
  const world = assignTiers(others.filter((e) => !isJapan(e)), (e) => `${e.region}|${e.era}`, scoring.tiers, { 1: seedT1.world });
  const japan = assignTiers(others.filter(isJapan), (e) => e.era, scoring.japan, { 1: seedT1.japan });
  const peopleWorld = assignTiers(people.filter((e) => !isJapan(e)), (e) => `${e.region}|${e.era}`, scoring.people.world);
  const peopleJapan = assignTiers(people.filter(isJapan), (e) => e.era, scoring.people.japan);

  const all = [...seedEvents, ...auto].sort((a, b) => a.year - b.year || a.tier - b.tier || b.score - a.score);
  writeJsonl(path.join(WORK_DIR, 'scored.jsonl'), all);
  writeJsonl(path.join(WORK_DIR, 'excluded.jsonl'), excluded);
  writeJsonl(path.join(WORK_DIR, 'duplicates.jsonl'), [
    ...[...matched].map(([sid, e]) => ({ seed_id: sid, id: e.id, title: e.title, status: 'merged' })),
    ...suspects.map((x) => ({ seed_id: x.seed.id, seed_title: x.seed.title, id: x.event.id, title: x.event.title, sim: x.sim, status: 'suspect' })),
  ]);

  const reasons = {};
  for (const x of excluded) {
    const k = x.reason.split(':')[0];
    reasons[k] = (reasons[k] || 0) + 1;
  }
  console.log(`入力 ${events.length}件 → 採用 ${all.length}件（種データ ${seedEvents.length}件、うちWikidataと統合 ${matched.size}件）`);
  console.log(`除外 ${excluded.length}件：`, reasons);
  console.log(`重複の疑い ${suspects.length}件`);
  console.log('tier（日本以外）：', world, '　種データ', seedT1.world);
  console.log('tier（日本国内）：', japan, '　種データ', seedT1.japan);
  console.log('tier（人物・日本以外）：', peopleWorld);
  console.log('tier（人物・日本国内）：', peopleJapan);
  console.log(`レビューの目印あり ${auto.filter((e) => e.review_flags.length).length}件`);
}

main();
