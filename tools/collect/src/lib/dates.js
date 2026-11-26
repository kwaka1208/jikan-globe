// Wikidataの日付 → 0年のない暦年（紀元前は負の数）
//
// 2026-11-26 に確かめたこと（HANDOFF 5.1）：
// - WDQS・QLever の年は天文学的年（0年あり）。紀元前490年は -0489 で返る。
// - 暦がユリウス暦（Q1985786）で精度が「日」（11）以上の日付は、グレゴリオ暦に換算して返る。
//   精度が「月」（10）以下は換算されない。
// そこで、日の精度のユリウス暦はユリウス暦に戻してから年を取り、0以下の年は1を引く。

export const JULIAN = 'Q1985786';
export const GREGORIAN = 'Q1985727';

// "-0489-09-07T00:00:00Z" → { y: -489, m: 9, d: 7 }
export function parseTime(s) {
  const m = String(s).match(/^([+-]?\d+)-(\d\d)-(\d\d)/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

// 通日（JDN）を使ったグレゴリオ暦 → ユリウス暦の換算（年は天文学的年）
function gregorianToJdn(y, m, d) {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function jdnToJulian(jdn) {
  const c = jdn + 32082;
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    d: e - Math.floor((153 * m + 2) / 5) + 1,
    m: m + 3 - 12 * Math.floor(m / 10),
    y: d - 4800 + Math.floor(m / 10),
  };
}

export const astroToHistorical = (y) => (y <= 0 ? y - 1 : y);

// SPARQLの値 → { year, month, day, precision, approx }
export function toCalendarYear({ time, precision, calendar }) {
  const t = parseTime(time);
  if (!t) return null;
  let { y, m, d } = t;
  if (calendar === JULIAN && precision >= 11 && m >= 1 && d >= 1) {
    ({ y, m, d } = jdnToJulian(gregorianToJdn(y, m, d)));
  }
  const year = astroToHistorical(y);
  return {
    year,
    month: precision >= 10 ? m : null,
    day: precision >= 11 ? d : null,
    precision,
    approx: precision < 9, // 9 = 年。10年・100年単位などはおよその年
  };
}

// 候補の中から1つ選ぶ。propOrder の順にプロパティを見て、
// 開始は一番早い年、終わりは一番遅い年を採る（同じ年なら精度の細かいもの）。
// 例：首里城の P571 は創建（年の精度）と再建（日の精度）があり、創建を採りたい
export function pickDate(cands, propOrder, { end = false } = {}) {
  const conv = cands
    .map((c) => ({ ...c, ...toCalendarYear(c) }))
    .filter((c) => c.year !== undefined && c.year !== null);
  for (const prop of propOrder) {
    const list = conv.filter((c) => c.prop === prop);
    if (!list.length) continue;
    const top = [...list].sort((a, b) => (end ? b.year - a.year : a.year - b.year) || b.precision - a.precision);
    const years = list.map((c) => c.year);
    return { ...top[0], spread: Math.max(...years) - Math.min(...years) };
  }
  return null;
}
