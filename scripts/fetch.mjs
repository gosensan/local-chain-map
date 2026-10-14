// ステップ1：店舗一覧ページのHTMLを取ってきて raw/ に保存するスクリプト
// 使い方：npm run fetch          （保存済みのページは取り直さない）
//         npm run fetch -- --force （全部取り直す）
//
// スクレイピングの作法
// - 1ページ取るごとに2秒待つ（相手のサーバーに負担をかけない）
// - 一度保存したページは取り直さない（何度やり直しても相手にアクセスしない）
// - どんなプログラムからのアクセスかを User-Agent で名乗る

import { mkdir, writeFile, access } from 'node:fs/promises';

const PAGES = [
  // オークワ：県ごとの店舗一覧
  { name: 'okuwa-wakayama', url: 'https://www.okuwa.net/store/wakayama.html' },
  { name: 'okuwa-osaka', url: 'https://www.okuwa.net/store/osaka.html' },
  { name: 'okuwa-nara', url: 'https://www.okuwa.net/store/nara.html' },
  { name: 'okuwa-mie', url: 'https://www.okuwa.net/store/mie.html' },
  { name: 'okuwa-gifu', url: 'https://www.okuwa.net/store/gifu.html' },
  { name: 'okuwa-aichi', url: 'https://www.okuwa.net/store/aichi.html' },
  { name: 'okuwa-shizuoka', url: 'https://www.okuwa.net/store/shizuoka.html' },
  // エバグリーン（廣岡グループ）：全店の一覧
  { name: 'hirooka-store', url: 'https://hirooka-g.co.jp/store/' },
  // よってって：店舗ページはJavaScriptがこのJSONを読んで表示している（開発者ツールで発見）
  { name: 'yottette-shoplist', url: 'https://www.yottette.jp/js/lib/shoplist.json', ext: 'json' },
];

const WAIT_MS = 2000;
const USER_AGENT = 'local-chain-map/0.1 (personal hobby project; store map)';
const force = process.argv.includes('--force');
const dir = new URL('../raw/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (u) => access(u).then(() => true, () => false);

await mkdir(dir, { recursive: true });

let fetched = 0;
for (const page of PAGES) {
  const file = new URL(`${page.name}.${page.ext || 'html'}`, dir);
  if (!force && (await exists(file))) {
    console.log(`保存済み  ${page.name}`);
    continue;
  }
  if (fetched > 0) await sleep(WAIT_MS);
  fetched++;
  try {
    const res = await fetch(page.url, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) {
      console.log(`失敗 ${res.status}  ${page.name}  ${page.url}`);
      continue;
    }
    // 文字コード（UTF-8かShift_JISか）はサイトによって違うので、
    // ここでは文字に変換せず、届いたデータをそのまま保存する
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(file, bytes);
    console.log(`保存     ${page.name}  （${Math.round(bytes.length / 1024)}KB）`);
  } catch (e) {
    console.log(`失敗     ${page.name}  ${e.message}`);
  }
}

console.log(`\n${fetched}ページを取得しました。raw/ フォルダを確認してください。`);
