// 年の変換（HANDOFF 11章「年」）
// fixtures/dates.json は WDQS が返す値と Wikidata 本体（wbgetentities）の値を記録したもの。
// WDQS の値を暦年に変換した結果が、本体の年と同じになることを確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toCalendarYear, pickDate } from '../src/lib/dates.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dates.json', import.meta.url), 'utf8'));
const byTitle = (t) => fixture.events.find((e) => e.title === t);
// 本体JSONの年は暦年（0年なし）そのもの
const jsonYear = (time) => Number(time.match(/^([+-]?\d+)-/)[1]);

test('WDQSの値を暦年に変換すると、本体JSONの年と一致する（全件）', () => {
  for (const ev of fixture.events) {
    const fromJson = [...new Set(ev.wikidata_json.map((j) => `${j.prop}|${jsonYear(j.time)}`))].sort();
    const fromWdqs = [...new Set(ev.wdqs.map((w) => `${w.prop}|${toCalendarYear(w).year}`))].sort();
    assert.deepEqual(fromWdqs, fromJson, ev.title);
  }
});

test('日付まで分かるユリウス暦の日付は、本体JSONの月日に戻る（マラトンの戦い）', () => {
  const ev = byTitle('マラトンの戦い');
  const got = ev.wdqs.map((w) => { const r = toCalendarYear(w); return `${r.year}-${r.month}-${r.day}`; }).sort();
  const want = ev.wikidata_json.map((j) => { const [, y, m, d] = j.time.match(/^([+-]?\d+)-(\d\d)-(\d\d)/); return `${Number(y)}-${Number(m)}-${Number(d)}`; }).sort();
  assert.deepEqual(got, want);
});

const yearOf = (title, props) => pickDate(byTitle(title).wdqs, props).year;

test('関ヶ原の戦い＝1600', () => assert.equal(yearOf('関ヶ原の戦い', ['P585', 'P580']), 1600));
test('マラトンの戦い＝-490（紀元前の年が1年ずれない）', () => assert.equal(yearOf('マラトンの戦い', ['P585', 'P580']), -490));
test('サラミスの海戦＝-480', () => assert.equal(yearOf('サラミスの海戦', ['P585', 'P580']), -480));
test('コンスタンティノープルの陥落＝1453', () => assert.equal(yearOf('コンスタンティノープルの陥落', ['P585', 'P580']), 1453));
test('アポロ11号＝1969', () => assert.equal(yearOf('アポロ11号', ['P619']), 1969));
test('首里城は再建（1958）ではなく創建の年を採る', () => assert.equal(yearOf('首里城', ['P571']), 1400));

test('年の境目：ユリウス暦1500年12月28日（グレゴリオ暦で1501年1月7日）は1500年', () => {
  assert.equal(toCalendarYear({ time: '1501-01-07T00:00:00Z', precision: 11, calendar: 'Q1985786' }).year, 1500);
});

test('0年は出てこない：天文学的年0は紀元前1年', () => {
  assert.equal(toCalendarYear({ time: '0000-01-01T00:00:00Z', precision: 9, calendar: 'Q1985727' }).year, -1);
});
