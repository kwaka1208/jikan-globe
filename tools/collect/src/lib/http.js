// User-Agent 付きの取得。429/503 は Retry-After と指数バックオフで再試行する
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TimeoutError extends Error {}

export async function request(url, { userAgent, maxRetries = 5, init = {} } = {}) {
  if (!userAgent) throw new Error('User-Agent が設定されていません（config/sources.yaml の client.user_agent）');
  let wait = 2000;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...init, headers: { 'User-Agent': userAgent, ...(init.headers || {}) } });
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleep(wait); wait *= 2; continue;
    }
    if (res.status === 429 || res.status === 503) {
      if (attempt >= maxRetries) throw new Error(`HTTP ${res.status}: ${url.slice(0, 120)}`);
      // QLever の 429 は1分以上続くことがあるので、429 は30秒から始めて最大5分まで延ばす
      if (res.status === 429) wait = Math.min(Math.max(wait, 30000), 300000);
      const ra = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait);
      wait *= 2; continue;
    }
    return res;
  }
}
