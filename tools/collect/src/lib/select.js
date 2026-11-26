// 説明文の選び方とレビューの判断の当て方（build と review で共通）
import fs from 'node:fs';
import path from 'node:path';
import { REVIEW_DIR } from './config.js';
import { readCache } from './cache.js';

export const DECISIONS_FILE = path.join(REVIEW_DIR, 'decisions.json');

export function loadDecisions() {
  return fs.existsSync(DECISIONS_FILE) ? JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf8')) : {};
}

// AI下書き（npm run draft の結果）。なければ undefined
export const loadDraft = (e) => readCache('draft', e.id);

// HANDOFF 6.5 の優先順位：human → ai-draft → wikipedia → wikidata
export function chooseText(e, decision) {
  if (decision?.text_final) return { text: decision.text_final, source: 'human' };
  if (e.text && e.text_source === 'human') return { text: e.text, source: 'human' };
  const draft = loadDraft(e);
  if (draft?.text) return { text: draft.text, source: 'ai-draft' };
  if (e.wikipedia_text) return { text: e.wikipedia_text, source: 'wikipedia' };
  if (e.desc_ja) return { text: e.desc_ja, source: 'wikidata' };
  return { text: null, source: null };
}

// レビューの判断を当てる。exclude なら null を返す
export function applyDecision(e, d) {
  if (!d) return e;
  if (d.decision === 'exclude') return null;
  const out = { ...e };
  if (d.decision === 'include') out.reviewed = true;
  if (d.japan_final) out.japan = d.japan_final;
  if (d.tier_final) out.tier = Number(d.tier_final);
  if (d.text_final) out.reviewed = true;
  return out;
}
