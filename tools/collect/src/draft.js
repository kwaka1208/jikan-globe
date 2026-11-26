// npm run draft（任意）
//
// tier 1〜2 のうち、説明文が Wikipedia の要約になるものを、小学校高学年向けの60〜90字に書き直す。
// OpenAI互換API（さくらのAI Engine を想定）を使う。接続先などは環境変数で渡す：
//   DRAFT_BASE_URL（例：https://…/v1）、DRAFT_API_KEY、DRAFT_MODEL
// キーがなければ何もせずに終わる（エラーにしない）。
// 結果は cache/draft/ に保存し、reviewed: false のまま。build で text_source: ai-draft として使われる。
// 元が Wikipedia（CC BY-SA 4.0）なので、書き直したものにも出典とライセンスの表示が要る。
import path from 'node:path';
import { loadConfig, WORK_DIR } from './lib/config.js';
import { readJsonl } from './lib/jsonl.js';
import { readCache, writeCache, hash } from './lib/cache.js';
import { parseArgs } from './lib/args.js';

const { DRAFT_BASE_URL, DRAFT_API_KEY, DRAFT_MODEL } = process.env;
if (!DRAFT_BASE_URL || !DRAFT_API_KEY || !DRAFT_MODEL) {
  console.log('AI下書きは飛ばしました（DRAFT_BASE_URL / DRAFT_API_KEY / DRAFT_MODEL が設定されていません）');
  process.exit(0);
}

const args = parseArgs();
const limit = args.limit ? Number(args.limit) : Infinity;
const filters = loadConfig('filters');

const SYSTEM = `あなたは小学校高学年の子ども向けに、歴史のできごとの説明文を書く編集者です。
次の決まりを必ず守ってください。
- 与えられた「元の文章」に書かれていることだけを使う。書かれていないことは推測で足さない。補足もしない。
- 年・人名・地名・数字は、元の文章にあるものだけを使う。
- 60〜90字の日本語で、です・ます調で書く。
- 小学校高学年で習わない難しい漢字や言葉は、やさしい言い方にする。
- 残酷な描写（死に方、けが、処刑など）は書かない。
- 説明文だけを出力する。前置きや記号は付けない。`;

async function rewrite(title, extract) {
  const res = await fetch(DRAFT_BASE_URL.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DRAFT_API_KEY}` },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `できごと：${title}\n\n元の文章：\n${extract}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return String(j.choices?.[0]?.message?.content || '').trim();
}

async function main() {
  const scored = readJsonl(path.join(WORK_DIR, 'scored.jsonl'));
  const targets = scored.filter((e) => e.tier <= 2 && e.text_source !== 'human' && e.wikipedia_text && e.jawiki);
  let done = 0, skipped = 0, rejected = 0;
  for (const e of targets) {
    if (done >= limit) break;
    const summary = readCache('wikipedia', e.jawiki);
    if (!summary?.extract) continue;
    const key = hash(summary.extract + DRAFT_MODEL);
    const prev = readCache('draft', e.id);
    if (prev?.key === key) { skipped++; continue; }
    const text = await rewrite(e.title, summary.extract);
    const bad = (filters.text_exclude_words || []).find((w) => text.includes(w));
    if (!text || text.length > 120 || bad) {
      rejected++;
      console.log(`  採用しない（${bad ? `語「${bad}」` : `${text.length}字`}）：${e.title}`);
      continue;
    }
    writeCache('draft', e.id, { text, key, model: DRAFT_MODEL, created_at: new Date().toISOString(), reviewed: false });
    done++;
    if (done % 20 === 0) console.log(`  ${done}件`);
  }
  console.log(`AI下書き：新しく ${done}件、キャッシュ済み ${skipped}件、採用しない ${rejected}件（対象 ${targets.length}件）`);
}

main().catch((e) => { console.error(e); process.exit(1); });
