// SPARQLエンドポイント（WDQS または QLever）。結果は接続先とクエリ文ごとにキャッシュする
import { request, TimeoutError } from './http.js';
import { readCache, writeCache } from './cache.js';

// QLever は PREFIX の宣言が必要（WDQS は宣言済み）
const QLEVER_PREFIXES = `PREFIX wd: <http://www.wikidata.org/entity/>
PREFIX wdt: <http://www.wikidata.org/prop/direct/>
PREFIX p: <http://www.wikidata.org/prop/>
PREFIX ps: <http://www.wikidata.org/prop/statement/>
PREFIX psv: <http://www.wikidata.org/prop/statement/value/>
PREFIX wikibase: <http://wikiba.se/ontology#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX schema: <http://schema.org/>
`;

export function createSparql({ endpoint, engine = 'wdqs', userAgent, maxRetries, refresh = false, log = () => {} }) {
  let live = 0;
  const prepare = (sparql) =>
    engine === 'qlever'
      ? QLEVER_PREFIXES + sparql.replace(/^\s*hint:.*$/gm, '') // hint: は WDQS（Blazegraph）専用
      : sparql;

  async function query(sparql, attempt = 0) {
    const key = `${endpoint}\n${sparql}`;
    if (!refresh) {
      const hit = readCache('sparql', key);
      if (hit) return hit;
    }
    const t0 = Date.now();
    const res = await request(endpoint, {
      userAgent,
      maxRetries,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
        body: 'query=' + encodeURIComponent(prepare(sparql)),
      },
    });
    let text;
    try {
      text = await res.text();
    } catch (e) {
      // 応答の途中で接続を切られた（大きすぎる・時間切れ）
      throw new TimeoutError(`connection closed after ${Date.now() - t0}ms: ${e.message}`);
    }
    live++;
    // WDQS は60秒を超えると 500（TimeoutException）や 502/504 を返す
    if (!res.ok) {
      if ([500, 502, 504].includes(res.status) && /timeout|TimeoutException|upstream/i.test(text)) {
        throw new TimeoutError(`timeout after ${Date.now() - t0}ms`);
      }
      // タイムアウト以外の 502/504（ゲートウェイの一時的な不調）は間隔を延ばして再試行する
      if ([502, 504].includes(res.status) && attempt < (maxRetries ?? 5)) {
        const wait = 5000 * 2 ** attempt;
        log(`  ${engine} HTTP ${res.status}：${wait / 1000}秒後に再試行します`);
        await new Promise((r) => setTimeout(r, wait));
        return query(sparql, attempt + 1);
      }
      throw new Error(`SPARQL HTTP ${res.status} (${engine}): ${text.slice(0, 300)}`);
    }
    let rows;
    try {
      rows = JSON.parse(text).results.bindings;
    } catch {
      // 200 のまま JSON が途中で切れることがある
      throw new TimeoutError(`broken response after ${Date.now() - t0}ms`);
    }
    log(`  ${engine} ${Date.now() - t0}ms ${rows.length} rows`);
    writeCache('sparql', key, rows);
    return rows;
  }
  return { query, get liveCount() { return live; } };
}

export const qid = (uri) => uri && uri.split('/').pop();
export const val = (b, k) => (b[k] ? b[k].value : undefined);
