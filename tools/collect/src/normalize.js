// npm run normalize
//
// cache/ の取得結果を整えて work/events.jsonl に書き出す。ネットには出ない。
// - 年：0年のない暦年にする（lib/dates.js）
// - 座標：できごと自体 → 場所（P276）→ 国の代表点 の順。どこから取ったかを coord_source に残す
// - 国：座標が入る国（今の国、Natural Earth 表記）。入らなければ P17 → 一番近い国
// - 日本との関わり：in / none。link は候補（japan_candidates）に理由を残すだけで、確定はレビューで行う
// - 説明文の材料：Wikipediaの冒頭1〜2文（最大120字程度）、Wikidataの日本語の説明
// 年や座標がなく地球儀に置けないものは work/excluded-normalize.jsonl に理由付きで残す。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CACHE_DIR, WORK_DIR } from './lib/config.js';
import { pickDate } from './lib/dates.js';
import { loadCountries } from './lib/geo.js';
import { readCache } from './lib/cache.js';

const cfg = loadConfig('sources');
const countries = loadCountries();
const wdDir = path.join(CACHE_DIR, 'wikidata');
const countryInfo = JSON.parse(fs.readFileSync(path.join(wdDir, '_countries.json'), 'utf8'));
const japanEntities = new Set(cfg.japan_entities.map((j) => j.qid));

const round = (n) => Math.round(n * 10000) / 10000;

// Wikidataの国QID → Natural Earth の国
const neCountry = (qid) => countries.byIso(countryInfo[qid]?.iso_num);

// Wikipediaの冒頭要約から、最初の1〜2文（最大 max 字程度、文の切れ目で切る）
export function shortExtract(text, max = 120) {
  if (!text) return null;
  let s = text.replace(/\s+/g, ' ').trim();
  // 読み仮名や外国語表記などの括弧書きを外す（入れ子にも対応）
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/（[^（）]*）|\([^()]*\)/g, ''); }
  // 括弧を外したあとに残る、日本語の間の空白を詰める（「万里の長城 は」→「万里の長城は」）
  for (let prev = ''; prev !== s; ) { prev = s; s = s.replace(/([^\x00-\x7F])\s+([^\x00-\x7F])/g, '$1$2'); }
  s = s.replace(/\s+([、。])/g, '$1').trim();
  const sentences = s.match(/[^。]+。?/g) || [];
  let out = '';
  for (const sen of sentences) {
    if (!out) out = sen;
    else if ((out + sen).length <= max) out += sen;
    else break;
    if (out.length >= max * 0.6) break;
  }
  if (out.length > max * 1.5) out = out.slice(0, max) + '…'; // 1文目がとても長いときだけ切る
  return out || null;
}

function locate(it) {
  if (it.coords?.length) return { ...it.coords[0], coord_source: 'self' };
  // 国を3つ以上またぐ場所（「東アジア」など）の座標は、おおまかな位置として扱う
  const locs = (it.locations || []).filter((l) => l.coords.length);
  const loc = locs.find((l) => l.countries.length < 3);
  if (loc) return { ...loc.coords[0], coord_source: 'location' };
  if (locs.length) return { ...locs[0].coords[0], coord_source: 'country', vague: true };
  // 国の代表点（P17、なければ場所の国）
  for (const q of [...(it.countries || []), ...(it.locations || []).flatMap((l) => l.countries)]) {
    const c = neCountry(q);
    if (c) return { ...c.center, coord_source: 'country' };
  }
  return null;
}

function countryOf(it, lat, lng) {
  const inside = countries.containing(lat, lng);
  if (inside) return { name: inside.name, how: 'contains' };
  const fine = countries.containingFine(lat, lng);
  if (fine) return { name: fine.name, how: 'contains_50m' };
  // P17、なければ場所（P276）の国。昔の国（琉球王国、明など）は ISO コードがないので飛ばされる
  for (const q of [...(it.countries || []), ...(it.locations || []).flatMap((l) => l.countries)]) {
    const c = neCountry(q);
    if (c) return { name: c.name, how: 'p17' };
  }
  return { name: countries.nearest(lat, lng).name, how: 'nearest' };
}

// 日本語の文字（かな・漢字）。日本語ラベルがローマ字だけのもの（「YOSHIKI」「BBNJ」、
// 英語名がそのまま入ったもの）は、日本語版の記事名に日本語の文字があればそちらを使う。
// 記事名の末尾の「 (歌手)」などの曖昧さ回避は外す。どちらもなければローマ字のまま残し、score で外す
const JA_CHAR = /[぀-ヿ㐀-鿿]/;
function titleOf(it) {
  const label = it.label_ja;
  if (!label || JA_CHAR.test(label)) return label;
  const wiki = (it.jawiki || '').replace(/\s*\([^)]*\)$/, '');
  return JA_CHAR.test(wiki) ? wiki : label;
}

function normalize(it, cat) {
  const start = pickDate(it.dates, cat.date_props);
  if (!start) return { drop: 'no_date' };
  const end = it.ends?.length ? pickDate(it.ends, cat.end_props, { end: true }) : null;
  const pos = locate(it);
  if (!pos) return { drop: 'no_coord' };
  const country = countryOf(it, pos.lat, pos.lng);

  const summary = it.jawiki ? readCache('wikipedia', it.jawiki) : undefined;
  const wikipedia = summary && !summary.missing && summary.type !== 'disambiguation' ? summary : null;

  // 日本との関わり。in は確定、link は候補だけ
  const japan = country.name === 'Japan' ? 'in' : 'none';
  const reasons = [];
  if (japan !== 'in') {
    if ((it.countries || []).some((q) => japanEntities.has(q))) reasons.push('p17');
    if ((it.participants || []).some((q) => japanEntities.has(q))) reasons.push('p710');
    const jpCount = (wikipedia?.extract || '').split('日本').length - 1;
    if (jpCount >= 2) reasons.push(`wikipedia:${jpCount}`);
  }

  // 場所の表示：場所（P276）→ 行政区画（P131）→ 国の日本語名
  const place =
    (it.locations || []).find((l) => l.label_ja)?.label_ja ||
    (it.admins || []).find((a) => a.label_ja)?.label_ja ||
    countryInfo[(it.countries || [])[0]]?.label_ja ||
    null;

  return {
    event: {
      id: it.qid,
      qid: it.qid,
      category: cat.name,
      classes: it.classes,
      types: it.types || [],
      year: start.year,
      year_end: end && end.year !== start.year ? end.year : null,
      approx: start.approx,
      date_prop: start.prop,
      date_precision: start.precision,
      date_spread: start.spread, // 同じ項目に年の違う値があるときの幅（レビューの目安）
      lat: round(pos.lat),
      lng: round(pos.lng),
      coord_source: pos.coord_source,
      vague_location: !!pos.vague,
      country: country.name,
      country_how: country.how,
      place,
      title: titleOf(it),
      title_en: it.label_en,
      desc_ja: it.desc_ja,
      sitelinks: it.sitelinks ?? 0,
      jawiki: it.jawiki,
      wikipedia_url: wikipedia?.url || null,
      wikipedia_text: shortExtract(wikipedia?.extract),
      wikipedia_length: wikipedia?.extract?.length || 0,
      japan,
      japan_candidates: reasons,
      reviewed: false,
    },
  };
}

function main() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const files = fs.readdirSync(wdDir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  // カテゴリの順は sources.yaml の順。同じQIDが複数カテゴリにあれば先のカテゴリを採る
  const order = Object.keys(cfg.categories);
  files.sort((a, b) => order.indexOf(a.replace('.json', '')) - order.indexOf(b.replace('.json', '')));

  const seen = new Map();
  const dropped = [];
  const stat = {};
  for (const f of files) {
    const { category, items } = JSON.parse(fs.readFileSync(path.join(wdDir, f), 'utf8'));
    const cat = { name: category, ...cfg.categories[category] };
    const s = (stat[category] = { input: items.length, ok: 0, no_date: 0, no_coord: 0, duplicate: 0 });
    for (const it of items) {
      if (seen.has(it.qid)) {
        s.duplicate++;
        seen.get(it.qid).also_in = [...(seen.get(it.qid).also_in || []), category];
        continue;
      }
      const r = normalize(it, cat);
      if (r.drop) {
        s[r.drop]++;
        dropped.push({ id: it.qid, category, reason: r.drop, title: it.label_ja || it.label_en });
        continue;
      }
      s.ok++;
      seen.set(it.qid, r.event);
    }
  }

  const events = [...seen.values()].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
  fs.writeFileSync(path.join(WORK_DIR, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(WORK_DIR, 'excluded-normalize.jsonl'), dropped.map((e) => JSON.stringify(e)).join('\n') + (dropped.length ? '\n' : ''));

  console.table(stat);
  const count = (f) => events.filter(f).length;
  console.log(`work/events.jsonl：${events.length}件`);
  console.log(`  座標：self ${count((e) => e.coord_source === 'self')} / location ${count((e) => e.coord_source === 'location')} / country ${count((e) => e.coord_source === 'country')}`);
  console.log(`  国の決め方：contains ${count((e) => e.country_how === 'contains')} / contains_50m ${count((e) => e.country_how === 'contains_50m')} / p17 ${count((e) => e.country_how === 'p17')} / nearest ${count((e) => e.country_how === 'nearest')}`);
  console.log(`  日本語タイトルなし ${count((e) => !e.title)}　Wikipedia要約あり ${count((e) => e.wikipedia_text)}`);
  console.log(`  japan：in ${count((e) => e.japan === 'in')}　link候補 ${count((e) => e.japan_candidates.length)}`);
  console.log(`  年が0のもの ${count((e) => e.year === 0)}`);
}

main();
