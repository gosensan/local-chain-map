// 調査用：よってっての店舗ページがちゃんと保存されているか、中に何が書かれているかを確認する
// 使い方：node scripts/check-yottette.mjs

import { readFile, readdir } from 'node:fs/promises';
import { keyOf } from './coords.mjs';

const urls = ['https://www.yottette.jp/inari', 'https://www.yottette.jp/gobo', 'https://www.yottette.jp/sumoto'];

try {
  const files = await readdir(new URL('../raw/detail/', import.meta.url));
  console.log(`raw/detail/ のファイル数：${files.length}`);
} catch {
  console.log('raw/detail/ フォルダがありません');
}

for (const url of urls) {
  const path = `raw/detail/${keyOf(url)}.html`;
  console.log(`\n■ ${url}  →  ${path}`);
  let html;
  try {
    html = await readFile(new URL(`../${path}`, import.meta.url), 'utf-8');
  } catch {
    console.log('  保存されていません');
    continue;
  }
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  console.log(`  サイズ：${html.length}文字`);
  console.log(`  「住所」：${html.includes('住所')}  「〒」：${html.includes('〒')}  「!2d」：${html.includes('!2d')}  「maps」：${html.includes('maps')}`);
  console.log(`  <title>：${html.match(/<title>([^<]*)/i)?.[1] ?? '(なし)'}`);
  const i = text.indexOf('住所');
  console.log(`  「住所」付近：${i >= 0 ? text.slice(i, i + 120) : '(なし)'}`);
  console.log(`  本文の最初：${text.trim().slice(0, 200)}`);
}
