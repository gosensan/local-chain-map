// ステップ2.5：各店の「店舗ページ」や「地図ページ」を取ってきて raw/detail/ に保存するスクリプト
// 目的：お店自身が公開している正確な緯度・経度を使うため
//
// 使い方：
//   npm run fetch:detail                 エバグリーン全店＋オークワの地図ページを1つだけ（お試し）
//   npm run fetch:detail -- --okuwa-all  オークワの地図ページも全店分
//
// 作法は fetch.mjs と同じ（2秒間隔・保存済みは取り直さない・User-Agentで名乗る）

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { findCoords, keyOf } from './coords.mjs';

const WAIT_MS = Number(process.env.WAIT_MS ?? 2000);
const USER_AGENT = 'local-chain-map/0.1 (personal hobby project; store map)';
const DIR = new URL('../raw/detail/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (u) => access(u).then(() => true, () => false);

let stores;
try {
  stores = JSON.parse(await readFile(new URL('../data/stores.json', import.meta.url), 'utf-8'));
} catch {
  throw new Error('data/stores.json がありません。先に npm run parse を実行してください');
}
await mkdir(DIR, { recursive: true });

const okuwaAll = process.argv.includes('--okuwa-all');
const targets = [];
for (const s of stores) {
  if (s.chain === 'オークワ') {
    if (s.mapUrl) targets.push({ store: s, url: s.mapUrl });
  } else if (s.url) {
    targets.push({ store: s, url: s.url });
  }
}
const okuwa = targets.filter((t) => t.store.chain === 'オークワ');
const list = [...targets.filter((t) => t.store.chain !== 'オークワ'), ...(okuwaAll ? okuwa : okuwa.slice(0, 1))];

let fetched = 0;
let saved = 0;
for (const t of list) {
  const file = new URL(`${keyOf(t.url)}.html`, DIR);
  if (await exists(file)) {
    saved++;
    continue;
  }
  if (fetched > 0) await sleep(WAIT_MS);
  fetched++;
  try {
    const res = await fetch(t.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      console.log(`\n失敗 ${res.status}  ${t.store.name}`);
      continue;
    }
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    saved++;
    process.stdout.write(`\r取得中… ${fetched} / ${list.length}`);
  } catch (e) {
    console.log(`\n失敗  ${t.store.name}（${e.message}）`);
  }
}
console.log(`\n新しく取得：${fetched}ページ（保存済みと合わせて ${saved}ページ）`);

// オークワのお試しページに緯度・経度が入っているかを判定する
if (!okuwaAll && okuwa.length) {
  const sample = okuwa[0];
  let html = '';
  try {
    html = (await readFile(new URL(`${keyOf(sample.url)}.html`, DIR))).toString('latin1');
  } catch {}
  const c = findCoords(html);
  console.log('\n▼ オークワの地図ページ（お試し1件）');
  if (c) {
    console.log(`  ${sample.store.name} のページに緯度・経度がありました（${c.lat}, ${c.lng}）`);
    console.log('  全店分を取るには：npm run fetch:detail -- --okuwa-all （約5分）');
  } else {
    console.log(`  ${sample.store.name} のページには緯度・経度が見つかりませんでした`);
    console.log('  オークワは住所からの変換（npm run geocode）を使います');
  }
}
