// キャッシュ：キー（クエリ文など）のハッシュでファイルに保存する
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_DIR } from './config.js';

export const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export function cachePath(kind, key) {
  return path.join(CACHE_DIR, kind, `${hash(key)}.json`);
}

export function readCache(kind, key) {
  const p = cachePath(kind, key);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : undefined;
}

export function writeCache(kind, key, value) {
  const p = cachePath(kind, key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value));
}
