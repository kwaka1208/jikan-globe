// npm run fetch [-- --refresh] [-- --only=war,building] [-- --skip-wikipedia]
//
// Wikidata と日本語版Wikipediaからできごとを取得し、cache/ に保存する。
// 1. 一覧：クラスごとに QID・日付・クラスを取る（タイムアウトしたらクラスや時代で分割）
// 2. 詳細：QID 200件ずつ、ラベル・説明・座標・場所・国・記事名・sitelink数を取る
// 3. 要約：jawikiの記事があるものは REST API で冒頭要約を取る
// 結果は cache/wikidata/<カテゴリ>.json にまとめて書き出す（normalize が読む）。
// 年はWDQSが返す値（天文学的年、日付つきのユリウス暦はグレゴリオ暦に換算済み）を
// そのまま保存し、暦年への変換は normalize で行う。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, CACHE_DIR } from './lib/config.js';
import { parseArgs, listArg } from './lib/args.js';
import { TimeoutError, request } from './lib/http.js';
import { createSparql, qid, val } from './lib/wdqs.js';
import { readCache, writeCache } from './lib/cache.js';

const args = parseArgs();
const refresh = !!args.refresh;
const only = listArg(args.only);
const cfg = loadConfig('sources');
const log = (...a) => console.log(...a);
const common = { userAgent: cfg.client.user_agent, maxRetries: cfg.client.max_retries, refresh, log };
// 詳細は WDQS、一覧（重い）は list_sparql（既定は QLever）
const wdqs = createSparql({ ...common, endpoint: cfg.client.sparql_endpoint, engine: 'wdqs' });
const lister = cfg.client.list_sparql ? createSparql({ ...common, ...cfg.client.list_sparql }) : wdqs;
// 日本語ラベルのないものは normalize 以降で必ず外れる（filters.yaml の allow_english_only）。
// 詳細の取得を減らすため、一覧の段階で外す（建物は全世界で15万件中14万件が日本語ラベルなし）
const jaOnly = !loadConfig('filters').labels?.allow_english_only;

const DETAIL_BATCH = 200;

// QIDを指定する軽いクエリ（WDQS）。接続が切られたら待って再試行し、
// それでもだめなら QID を半分に分けて取り直す（全世界で数千回投げるため、一時的な不調で止めない）
async function queryIds(ids, build, attempt = 0) {
  try {
    return await wdqs.query(build(ids));
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    if (attempt < 2) {
      const wait = 30000 * (attempt + 1);
      log(`  wdqs ${e.message}：${wait / 1000}秒後に再試行します（${ids.length}件）`);
      await new Promise((r) => setTimeout(r, wait));
      return queryIds(ids, build, attempt + 1);
    }
    if (ids.length <= 1) throw e;
    const mid = Math.ceil(ids.length / 2);
    log(`  wdqs ${ids.length}件を2つに分けます`);
    return [...(await queryIds(ids.slice(0, mid), build)), ...(await queryIds(ids.slice(mid), build))];
  }
}
const values = (ids) => ids.map((i) => `wd:${i}`).join(' ');

// 暦年（0年なし）→ WDQS の YEAR()（天文学的年）
const toAstro = (y) => (y < 0 ? y + 1 : y);

// periods 設定から時代の区切りを作る。前後には上限なしの区間を足す
function periodRanges() {
  const out = [];
  for (const p of cfg.periods) {
    for (let y = p.from; y < p.to; y += p.step) out.push([y, Math.min(y + p.step, p.to)]);
  }
  return [[null, out[0][0]], ...out, [out.at(-1)[1], null]];
}

async function subclassesOf(classQid) {
  const rows = await lister.query(`SELECT ?s WHERE { ?s wdt:P279* wd:${classQid} }`);
  return rows.map((b) => qid(val(b, 's')));
}

function scopeFilter() {
  const cs = cfg.scope?.countries || [];
  if (!cs.length) return '';
  return `VALUES ?sc { ${values(cs.map((c) => c.qid))} }
  FILTER EXISTS { { ?item wdt:P17 ?sc } UNION { ?item wdt:P276/wdt:P17 ?sc } }`;
}

// カテゴリごとの一覧の絞り込み（日本語ラベル・sitelink数の下限）
function itemFilter(cat) {
  const f = [];
  if (jaOnly) f.push('FILTER EXISTS { ?item rdfs:label ?jaL FILTER(LANG(?jaL) = "ja") }');
  if (cat.min_sitelinks) f.push(`?item wikibase:sitelinks ?slN . FILTER(?slN >= ${Number(cat.min_sitelinks)})`);
  return f.join('\n  ');
}

// 一覧クエリ。match は「?item がこのカテゴリに当たる」条件
// scope が false のときは国の絞り込みをしない（QIDを指定して取るときなど）
function listQuery(match, dateProps, range, { scope = true } = {}) {
  const dates = dateProps
    .map((p) => `{ ?item p:${p} ?st . ?st psv:${p} ?v . BIND("${p}" AS ?dp) }`)
    .join(' UNION ');
  let yearFilter = '';
  if (range) {
    const [a, b] = range;
    const conds = [];
    if (a !== null) conds.push(`YEAR(?t) >= ${toAstro(a)}`);
    if (b !== null) conds.push(`YEAR(?t) < ${toAstro(b)}`);
    yearFilter = `FILTER(${conds.join(' && ')})`;
  }
  return `SELECT ?item ?cls ?dp ?t ?prec ?cal WHERE {
  hint:Query hint:optimizer "None" .
  ${match}
  ${scope ? scopeFilter() : ''}
  ${dates}
  ?st wikibase:rank ?rank . FILTER(?rank != wikibase:DeprecatedRank)
  ?v wikibase:timeValue ?t ; wikibase:timePrecision ?prec ; wikibase:timeCalendarModel ?cal .
  ${yearFilter}
}`;
}

// タイムアウトしたら、クラスを半分に分ける。1クラスなら時代で分ける
async function fetchList(classes, dateProps, filter, range = null, depth = 0) {
  const pad = '  '.repeat(depth + 1);
  const match = `VALUES ?cls { ${values(classes)} } ?item wdt:P31 ?cls .\n  ${filter}`;
  try {
    return await lister.query(listQuery(match, dateProps, range));
  } catch (e) {
    if (!(e instanceof TimeoutError)) throw e;
    if (classes.length > 1) {
      log(`${pad}タイムアウト：${classes.length}クラスを2つに分けます`);
      const mid = Math.ceil(classes.length / 2);
      return [
        ...(await fetchList(classes.slice(0, mid), dateProps, filter, range, depth + 1)),
        ...(await fetchList(classes.slice(mid), dateProps, filter, range, depth + 1)),
      ];
    }
    if (range) throw new Error(`1クラス・1区間でもタイムアウトしました：${classes[0]} ${range}（periods を細かくしてください）`);
    log(`${pad}タイムアウト：${classes[0]} を時代で分けます`);
    const out = [];
    for (const r of periodRanges()) out.push(...(await fetchList(classes, dateProps, filter, r, depth + 1)));
    return out;
  }
}

// 世界遺産など、クラスではなく P1435（遺産の指定）で取るもの
async function fetchHeritage(heritageQid, dateProps, filter) {
  const match = `?item wdt:P1435 wd:${heritageQid} . BIND(wd:${heritageQid} AS ?cls)\n  ${filter}`;
  return lister.query(listQuery(match, dateProps, null));
}

// placeProps：場所を表す属性（既定は P276。人物は P19 出生地）
function detailQuery(ids, placeProps = ['P276']) {
  const place = placeProps.map((p) => `wdt:${p}`).join('|');
  return `SELECT ?item ?sl ?ja ?en ?desc ?coord ?loc ?locJa ?locCoord ?locCountry ?country ?jawiki WHERE {
  VALUES ?item { ${values(ids)} }
  ?item wikibase:sitelinks ?sl .
  OPTIONAL { ?item rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "ja") }
  OPTIONAL { ?item wdt:P625 ?coord }
  OPTIONAL { ?item ${place} ?loc .
    OPTIONAL { ?loc rdfs:label ?locJa FILTER(LANG(?locJa) = "ja") }
    OPTIONAL { ?loc wdt:P625 ?locCoord }
    OPTIONAL { ?loc wdt:P17 ?locCountry } }
  OPTIONAL { ?item wdt:P17 ?country }
  OPTIONAL { ?jwp schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> ; schema:name ?jawiki }
}`;
}

// 種類（P31：除外ルールに使う）、参加者（P710：日本との関わりに使う）、
// 所在地の行政区画（P131：場所の表示に使う）。行が掛け算で増えないよう UNION で取る
function relationsQuery(ids) {
  return `SELECT ?item ?type ?part ?adm ?admJa WHERE {
  VALUES ?item { ${values(ids)} }
  { ?item wdt:P31 ?type }
  UNION { ?item wdt:P710 ?part }
  UNION { ?item wdt:P131 ?adm . OPTIONAL { ?adm rdfs:label ?admJa FILTER(LANG(?admJa) = "ja") } }
}`;
}

// "Point(lng lat)" → { lat, lng }
function parsePoint(s) {
  const m = s && s.match(/Point\(([-\d.eE]+) ([-\d.eE]+)\)/);
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : null;
}

const uniq = (a) => [...new Set(a.filter((x) => x !== undefined && x !== null))];

async function fetchDetails(ids, placeProps) {
  const out = new Map();
  const sorted = [...ids].sort();
  for (let i = 0; i < sorted.length; i += DETAIL_BATCH) {
    const part = sorted.slice(i, i + DETAIL_BATCH);
    log(`  詳細 ${i + part.length}/${sorted.length}`);
    const rows = await queryIds(part, (p) => detailQuery(p, placeProps));
    const blank = () => ({ sitelinks: 0, ja: [], en: [], desc: [], coords: [], locations: new Map(), countries: [], jawiki: [], types: [], participants: [], admins: new Map() });
    for (const b of rows) {
      const id = qid(val(b, 'item'));
      if (!out.has(id)) out.set(id, blank());
      const d = out.get(id);
      d.sitelinks = Number(val(b, 'sl') || 0);
      d.ja.push(val(b, 'ja')); d.en.push(val(b, 'en')); d.desc.push(val(b, 'desc'));
      d.coords.push(val(b, 'coord')); d.countries.push(qid(val(b, 'country')));
      d.jawiki.push(val(b, 'jawiki'));
      const loc = qid(val(b, 'loc'));
      if (loc) {
        if (!d.locations.has(loc)) d.locations.set(loc, { qid: loc, ja: [], coords: [], countries: [] });
        const l = d.locations.get(loc);
        l.ja.push(val(b, 'locJa')); l.coords.push(val(b, 'locCoord')); l.countries.push(qid(val(b, 'locCountry')));
      }
    }
    for (const b of await queryIds(part, relationsQuery)) {
      const d = out.get(qid(val(b, 'item')));
      if (!d) continue;
      if (b.type) d.types.push(qid(val(b, 'type')));
      if (b.part) d.participants.push(qid(val(b, 'part')));
      if (b.adm) d.admins.set(qid(val(b, 'adm')), val(b, 'admJa') || d.admins.get(qid(val(b, 'adm'))) || null);
    }
  }
  const result = new Map();
  for (const [id, d] of out) {
    result.set(id, {
      sitelinks: d.sitelinks,
      label_ja: uniq(d.ja)[0] || null,
      label_en: uniq(d.en)[0] || null,
      desc_ja: uniq(d.desc)[0] || null,
      coords: uniq(d.coords).map(parsePoint).filter(Boolean),
      locations: [...d.locations.values()].map((l) => ({
        qid: l.qid,
        label_ja: uniq(l.ja)[0] || null,
        coords: uniq(l.coords).map(parsePoint).filter(Boolean),
        countries: uniq(l.countries),
      })),
      countries: uniq(d.countries),
      jawiki: uniq(d.jawiki)[0] || null,
      types: uniq(d.types),
      participants: uniq(d.participants),
      admins: [...d.admins].map(([q, ja]) => ({ qid: q, label_ja: ja })),
    });
  }
  return result;
}

async function fetchCategory(name, cat) {
  log(`\n■ ${name}（${cat.label}）`);
  const classSet = new Set();
  for (const c of cat.classes || []) {
    const subs = cat.subclasses ? await subclassesOf(c.qid) : [c.qid];
    subs.forEach((s) => classSet.add(s));
  }
  log(`  クラス ${classSet.size}件（下位クラスを含む）`);

  const filter = itemFilter(cat);
  const rows = classSet.size ? await fetchList([...classSet], cat.date_props, filter) : [];
  for (const h of cat.heritage || []) {
    log(`  ${h.label}（P1435 = ${h.qid}）`);
    rows.push(...(await fetchHeritage(h.qid, cat.date_props, filter)));
  }

  // 終わりの年
  const endRows = [];
  if (cat.end_props?.length) {
    const ids = uniq(rows.map((b) => qid(val(b, 'item'))));
    for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
      const part = ids.slice(i, i + DETAIL_BATCH).sort();
      endRows.push(...(await queryIds(part, (p) => listQuery(`VALUES ?item { ${values(p)} }`, cat.end_props, null, { scope: false }))));
    }
  }

  // QIDごとにまとめる
  const items = new Map();
  const dateOf = (b) => ({ prop: val(b, 'dp'), time: val(b, 't'), precision: Number(val(b, 'prec')), calendar: qid(val(b, 'cal')) });
  for (const b of rows) {
    const id = qid(val(b, 'item'));
    if (!items.has(id)) items.set(id, { qid: id, category: name, classes: new Set(), dates: [], ends: [] });
    const it = items.get(id);
    if (b.cls) it.classes.add(qid(val(b, 'cls')));
    it.dates.push(dateOf(b));
  }
  for (const b of endRows) items.get(qid(val(b, 'item')))?.ends.push(dateOf(b));
  log(`  できごと ${items.size}件`);

  const details = await fetchDetails([...items.keys()], cat.place_props);
  const out = [];
  for (const it of items.values()) {
    const key = (d) => `${d.prop}|${d.time}|${d.precision}|${d.calendar}`;
    const dedupe = (a) => [...new Map(a.map((d) => [key(d), d])).values()];
    out.push({ ...it, classes: [...it.classes], dates: dedupe(it.dates), ends: dedupe(it.ends), ...(details.get(it.qid) || {}) });
  }
  return out;
}

// 国（P17 の値）の日本語名と ISO 3166-1 数字コード（P299）。
// normalize で Natural Earth の国名に対応づけるのに使う（world-atlas の id が ISO 数字コード）。
// --only で一部のカテゴリだけ取ったときに他のカテゴリの国が消えないよう、既存のファイルに足していく
async function fetchCountries(qids, file) {
  const known = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const ids = [...qids].sort();
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    const part = ids.slice(i, i + DETAIL_BATCH);
    const rows = await queryIds(part, (p) => `SELECT ?c ?ja ?en ?iso WHERE {
  VALUES ?c { ${values(p)} }
  OPTIONAL { ?c rdfs:label ?ja FILTER(LANG(?ja) = "ja") }
  OPTIONAL { ?c rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?c wdt:P299 ?iso }
}`);
    for (const b of rows) {
      const id = qid(val(b, 'c'));
      const k = known[id] || (known[id] = { label_ja: null, label_en: null, iso_num: null });
      k.label_ja ??= val(b, 'ja') || null;
      k.label_en ??= val(b, 'en') || null;
      k.iso_num ??= val(b, 'iso') || null;
    }
  }
  fs.writeFileSync(file, JSON.stringify(known, null, 1));
  log(`  ISOコードあり ${Object.values(known).filter((k) => k.iso_num).length}/${Object.keys(known).length}件`);
}

// filters.yaml の除外クラスを下位クラスまで広げて保存する（score がオフラインで判定できるように）
async function fetchFilterClasses(file) {
  const filters = loadConfig('filters');
  const out = {};
  for (const c of filters.exclude_classes || []) {
    for (const s of await subclassesOf(c.qid)) out[s] ??= c.label;
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 1));
  log(`  ${(filters.exclude_classes || []).length}クラス → 下位クラスを含めて ${Object.keys(out).length}件`);
}

// 日本語版Wikipediaの冒頭要約（記事名ごとにキャッシュ）
// 応答待ちが長いので wikipedia_concurrency 本まで並べ、開始の間隔で毎秒 wikipedia_rps 件以下に抑える
async function fetchSummaries(titles) {
  const { user_agent, wikipedia_summary, wikipedia_rps = 3, wikipedia_concurrency = 3, max_retries } = cfg.client;
  const interval = 1000 / wikipedia_rps;
  const todo = refresh ? titles : titles.filter((t) => !readCache('wikipedia', t));
  log(`  キャッシュ済み ${titles.length - todo.length}件、これから取得 ${todo.length}件`);
  let next = 0, live = 0, lastStart = 0;
  const slot = async () => {
    // 前の開始から interval 以上あける
    const now = Date.now();
    const at = Math.max(now, lastStart + interval);
    lastStart = at;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  async function worker() {
    while (next < todo.length) {
      const title = todo[next++];
      await slot();
      const res = await request(wikipedia_summary + encodeURIComponent(title.replace(/ /g, '_')), { userAgent: user_agent, maxRetries: max_retries });
      let value;
      if (res.status === 404) value = { missing: true };
      else if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}: ${title}`);
      else {
        const j = await res.json();
        value = { title: j.title, extract: j.extract, url: j.content_urls?.desktop?.page, type: j.type };
      }
      writeCache('wikipedia', title, value);
      if (++live % 200 === 0) log(`  要約 ${live}/${todo.length}`);
    }
  }
  await Promise.all(Array.from({ length: wikipedia_concurrency }, worker));
  log(`  要約 ${titles.length}件（新しく取得 ${live}件）`);
}

async function main() {
  const names = Object.entries(cfg.categories)
    .filter(([n, c]) => (only ? only.includes(n) : c.enabled))
    .map(([n]) => n);
  if (!names.length) throw new Error('取得するカテゴリがありません（enabled か --only を確認してください）');
  const scope = cfg.scope?.countries?.length ? cfg.scope.countries.map((c) => c.label).join('・') : '全世界';
  log(`取得するカテゴリ：${names.join(', ')}　範囲：${scope}${refresh ? '（--refresh）' : ''}`);

  const dir = path.join(CACHE_DIR, 'wikidata');
  fs.mkdirSync(dir, { recursive: true });
  const titles = new Set();
  const countryQids = new Set();
  for (const name of names) {
    const items = await fetchCategory(name, cfg.categories[name]);
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ category: name, fetched_at: new Date().toISOString(), scope: cfg.scope || null, items }, null, 1));
    for (const it of items) {
      if (it.jawiki) titles.add(it.jawiki);
      (it.countries || []).forEach((c) => countryQids.add(c));
      (it.locations || []).forEach((l) => l.countries.forEach((c) => countryQids.add(c)));
    }
  }

  log('\n■ 除外するクラス（filters.yaml）');
  await fetchFilterClasses(path.join(dir, '_filter_classes.json'));

  log(`\n■ 国の情報（${countryQids.size}件）`);
  await fetchCountries(countryQids, path.join(dir, '_countries.json'));
  log(`\n問い合わせ：一覧 ${lister.liveCount}回、詳細 ${wdqs.liveCount}回（残りはキャッシュ）`);

  if (args['skip-wikipedia']) log('Wikipediaの要約は飛ばしました（--skip-wikipedia）');
  else {
    log(`\n■ Wikipediaの要約（${titles.size}記事）`);
    await fetchSummaries([...titles].sort());
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
