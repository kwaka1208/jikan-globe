// 国の判定（HANDOFF 11章「国の判定」）。アプリと同じ countries.json と d3-geo を使う
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCountries } from '../src/lib/geo.js';

const C = loadCountries();
const countryAt = (lat, lng) => (C.containing(lat, lng) || C.containingFine(lat, lng) || C.nearest(lat, lng)).name;

test('関ヶ原の戦い → Japan', () => assert.equal(countryAt(35.3705, 136.4616), 'Japan'));
test('ギザの大ピラミッド → Egypt', () => assert.equal(countryAt(29.9792, 31.1342), 'Egypt'));
test('モアイ（イースター島）→ Chile', () => assert.equal(countryAt(-27.1212, -109.3664), 'Chile'));
test('ISOコード 392 → Japan', () => assert.equal(C.byIso('392').name, 'Japan'));
test('沖縄本島（110mの国境にない）→ Japan', () => assert.equal(countryAt(26.2172, 127.7195), 'Japan'));
test('香港（50mにしかない地域）は50mの判定に使わない', () => assert.equal(C.containingFine(22.37, 113.98), null));
