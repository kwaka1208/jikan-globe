// 出力（app/data/）の受け入れテスト（HANDOFF 11章）。npm run build のあとに実行する
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import YAML from 'yaml';
import { ROOT_DIR, COLLECT_DIR } from '../src/lib/config.js';

const DATA = path.join(ROOT_DIR, 'app/data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const meta = read('meta.json');
const index = read('index-tier12.json');
const all = [...index, ...meta.chunks.flatMap((c) => read(c.file))];
const seeds = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'seed/curated-seed.json'), 'utf8')).events;
const filters = YAML.parse(fs.readFileSync(path.join(COLLECT_DIR, 'config/filters.yaml'), 'utf8'));
const find = (title) => all.filter((e) => e.t === title);

test('meta.json の件数と、実際のファイルの件数が合う', () => {
  assert.equal(all.length, meta.count);
});

test('0年のできごとがない', () => {
  assert.deepEqual(all.filter((e) => e.y === 0).map((e) => e.t), []);
});

test('全件に日本語のタイトルがある', () => {
  assert.deepEqual(all.filter((e) => !e.t || !/[぀-ヿ㐀-鿿]/.test(e.t)).map((e) => e.id), []);
});

test('tier 1 に種データの135件がすべて含まれる', () => {
  assert.equal(seeds.length, 135);
  const t1 = all.filter((e) => e.tr === 1 && e.src === 'seed');
  assert.equal(t1.length, 135);
});

test('重複：種データの「関ヶ原の戦い」と Wikidata の同じ記事が1件にまとまる', () => {
  const s = find('関ヶ原の戦い');
  assert.equal(s.length, 1);
  assert.equal(s[0].id, 'Q234188');
  assert.equal(s[0].src, 'seed');
  assert.equal(s[0].y, 1600);
});

test('除外：filters.yaml の語を含むタイトルが出力にない', () => {
  const ov = filters.category_overrides || {};
  const hits = all.filter((e) => !ov[e.id] && filters.exclude_words.some((w) => e.t.includes(w)));
  assert.deepEqual(hits.map((e) => e.t), []);
});

test('カテゴリの付け直し：category_overrides のとおりになっている', () => {
  for (const [id, o] of Object.entries(filters.category_overrides || {})) {
    for (const e of all.filter((x) => x.id === id)) assert.equal(e.cat, o.category, o.label);
  }
});

test('サイズ：index-tier12.json が gzip 後に500KB以下', () => {
  const gz = zlib.gzipSync(fs.readFileSync(path.join(DATA, 'index-tier12.json'))).length;
  assert.ok(gz <= 500 * 1024, `${(gz / 1024).toFixed(1)}KB`);
});

test('サイズ：チャンクと説明文のファイルが gzip 後におおむね200KB以下', () => {
  const big = [...meta.chunks, ...meta.text].filter((c) => c.gz > 220 * 1024).map((c) => `${c.file} ${(c.gz / 1024).toFixed(0)}KB`);
  assert.deepEqual(big, []);
});

test('チャンクの年の範囲が重ならず、すき間もない', () => {
  for (const list of [meta.chunks, meta.text]) {
    for (let i = 1; i < list.length; i++) assert.equal(list[i].from, list[i - 1].to + 1, list[i].file);
  }
});

test('国の判定：出力の関ヶ原の戦い→Japan、ギザの大ピラミッド→Egypt、モアイ→Chile', () => {
  assert.equal(find('関ヶ原の戦い')[0]?.c, 'Japan');
  assert.equal(find('ギザの大ピラミッド')[0]?.c, 'Egypt');
  assert.equal(all.find((e) => e.t.includes('モアイ'))?.c, 'Chile');
});

// 年の受け入れ対象。種データでは別の書き方で入っているものもあるので、どれかのタイトルで見つける。
// マラトンの戦いは種データになく、取得範囲を全世界に広げるまで出力に入らない（フェーズ1の前半では失敗する）
test('年：出力の関ヶ原の戦い=1600、マラトンの戦い=-490、コンスタンティノープルの陥落=1453、アポロ11号=1969', () => {
  const cases = [
    { name: '関ヶ原の戦い', titles: ['関ヶ原の戦い'], year: 1600 },
    { name: 'マラトンの戦い', titles: ['マラトンの戦い'], year: -490 },
    { name: 'コンスタンティノープルの陥落', titles: ['コンスタンティノープルの陥落', '東ローマ帝国がほろびる'], year: 1453 },
    { name: 'アポロ11号', titles: ['アポロ11号', '人類が月に立つ'], year: 1969 },
  ];
  const got = Object.fromEntries(cases.map((c) => [c.name, c.titles.flatMap(find)[0]?.y ?? '出力にない']));
  const want = Object.fromEntries(cases.map((c) => [c.name, c.year]));
  assert.deepEqual(got, want);
});
