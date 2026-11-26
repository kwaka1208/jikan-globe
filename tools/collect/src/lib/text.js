// タイトルの近さと距離（種データとの重複判定に使う）

// 比べる前に、空白・記号・「の」をそろえる（「関ヶ原の戦い」と「関ケ原戦い」を近いとみなす）
const norm = (s) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/[ヶケ]/g, 'ケ')
    .replace(/[\s・、。「」『』（）()〈〉\-–—の]/g, '');

const bigrams = (s) => {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
};

// 文字の2-gramの一致率（Dice係数）。0〜1
export function titleSimilarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const bx = bigrams(x), by = bigrams(y);
  let common = 0;
  for (const [k, n] of bx) common += Math.min(n, by.get(k) || 0);
  return (2 * common) / (x.length - 1 + (y.length - 1));
}

// 2点間の距離（km）
export function distanceKm(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
