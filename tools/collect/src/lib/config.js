// 設定ファイル（config/*.yaml）とパスの読み込み
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
export const COLLECT_DIR = path.resolve(here, '../..');
export const ROOT_DIR = path.resolve(COLLECT_DIR, '../..');
export const CACHE_DIR = path.join(COLLECT_DIR, 'cache');
export const WORK_DIR = path.join(COLLECT_DIR, 'work');
export const REVIEW_DIR = path.join(COLLECT_DIR, 'review');

export function loadConfig(name) {
  const file = path.join(COLLECT_DIR, 'config', `${name}.yaml`);
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}
