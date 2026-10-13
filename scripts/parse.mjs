// ステップ2：raw/ に保存したHTMLから店名と住所を読み取り、data/stores.json に書き出すスクリプト
// 使い方：npm run parse
//
// このスクリプトはインターネットにアクセスしない（保存済みのHTMLだけを読む）
// サイトの作りが変わったら、ここの「読み取り方」を直す

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { findCoords, keyOf } from './coords.mjs';

const RAW = new URL('../raw/', import.meta.url);
const OUT_DIR = new URL('../data/', import.meta.url);

// 文字コードを見分けて文字に変換する（オークワは Shift_JIS、エバグリーンは UTF-8）
function decode(bytes) {
  const head = bytes.subarray(0, 2000).toString('latin1');
  const charset = (head.match(/charset=["']?([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
  return iconv.decode(bytes, charset.includes('shift') || charset.includes('sjis') ? 'Shift_JIS' : 'utf-8');
}

// 空白や改行をまとめる。全角の数字とハイフンは半角にそろえる
const clean = (s) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－−]/g, '-');

// <br> を空白に置き換えてから文字を取り出す（「オーストリート<br>和歌山北バイパス店」をつなげるため）
const textOf = ($, el) => {
  const c = $(el).clone();
  c.find('br').replaceWith(' ');
  return clean(c.text());
};

const prefOf = (address) => address.match(/^(東京都|北海道|(?:京都|大阪)府|.{2,3}県)/)?.[1] ?? '';

// --- オークワ：<div id="list"> の表。1行1店舗 ---
// 列：店舗名 / チラシ / 営業時間 / 郵便番号・所在地 / 地図 / 電話番号
function parseOkuwa(html, pageUrl) {
  const $ = cheerio.load(html);
  const stores = [];
  $('#list table tr').each((_, tr) => {
    const td = $(tr).find('td');
    if (td.length < 6) return; // 見出し行など
    const name = textOf($, td.eq(0));
    const [postal = '', ...rest] = $(td.eq(3)).html().split(/<br\s*\/?>/i).map((s) => clean(cheerio.load(s).text()));
    const address = rest.join(' ');
    if (!address || name.startsWith('e-ショップ')) return; // ネットショップは実店舗ではないので外す
    const href = td.eq(0).find('a').attr('href');
    const mapHref = td.eq(4).find('a').attr('href');
    stores.push({
      chain: 'オークワ',
      format: name.split(' ')[0], // オークワ / スーパーセンターオークワ / プライスカット など
      name,
      address,
      postal,
      phone: textOf($, td.eq(5)),
      hours: textOf($, td.eq(2)),
      url: href ? new URL(href, pageUrl).href : pageUrl,
      mapUrl: mapHref ? new URL(mapHref, pageUrl).href : '',
    });
  });
  return stores;
}

// --- 廣岡グループ（エバグリーンなど）：業態ごとの table.tbl_store ---
// 列：店舗名(th.td01) / 住所と電話(td.td02) / 営業時間(td.td03)
// 業態の見出し画像はエバグリーンとスーパーエバグリーンで同じなので、店名の頭で見分ける
const HIROOKA_BRANDS = ['スーパーエバグリーン', 'エバグリーン']; // 長い名前から先に比べる

function parseHirooka(html) {
  const $ = cheerio.load(html);
  const stores = [];
  $('table.tbl_store tbody tr').each((_, tr) => {
    const name = textOf($, $(tr).find('th.td01'));
    const brand = HIROOKA_BRANDS.find((b) => name.startsWith(b));
    if (!brand) return; // 今回はエバグリーンとスーパーエバグリーンだけを対象にする
    const td02 = $(tr).find('td.td02');
    const phone = clean(td02.find('.js-tellink').text());
    let address = clean(td02.clone().children().remove().end().text().replace(/TEL\./, ''));
    // 都道府県が書かれていない店がある（例：「西牟婁郡上富田町…」）。この会社の店は和歌山県が中心なので補う
    if (!prefOf(address)) {
      console.log(`  都道府県を補完：${name}（${address} → 和歌山県${address}）`);
      address = `和歌山県${address}`;
    }
    stores.push({
      chain: brand,
      format: name.split(' ')[0], // エバグリーン / エバグリーンプラス / スーパーエバグリーン など
      name,
      address,
      postal: '',
      phone,
      hours: textOf($, $(tr).find('td.td03')),
      url: $(tr).find('th.td01 a').attr('href') || 'https://hirooka-g.co.jp/store/',
    });
  });
  return stores;
}

// --- 実行 ---
const files = (await readdir(RAW)).filter((f) => f.endsWith('.html')).sort();
const all = [];
for (const f of files) {
  const html = decode(await readFile(new URL(f, RAW)));
  let stores = [];
  if (f.startsWith('okuwa-')) {
    stores = parseOkuwa(html, `https://www.okuwa.net/store/${f.replace('okuwa-', '')}`);
  } else if (f.startsWith('hirooka-')) {
    stores = parseHirooka(html);
  }
  console.log(`${f.padEnd(22)} ${String(stores.length).padStart(3)}店`);
  all.push(...stores);
}

// 同じ店が二重に入らないようにする（店名＋住所が同じものは1つに）
const seen = new Set();
const unique = all.filter((s) => {
  const key = `${s.name}|${s.address}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
unique.forEach((s, i) => {
  s.id = `store-${String(i + 1).padStart(3, '0')}`;
  s.pref = prefOf(s.address);
});

// 店舗ページ・地図ページ（npm run fetch:detail で保存したもの）があれば、そこから正確な緯度・経度を取る
let official = 0;
for (const s of unique) {
  const page = s.chain === 'オークワ' ? s.mapUrl : s.url.includes('/tenpo/') ? s.url : '';
  if (!page) continue;
  try {
    const c = findCoords((await readFile(new URL(`detail/${keyOf(page)}.html`, RAW))).toString('latin1'));
    if (c) {
      s.lat = c.lat;
      s.lng = c.lng;
      s.coordSource = 'official';
      official++;
    }
  } catch {
    // まだ取ってきていない店は、あとで住所から変換する
  }
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(new URL('stores.json', OUT_DIR), JSON.stringify(unique, null, 2) + '\n');

const count = (key) =>
  Object.entries(unique.reduce((m, s) => ((m[s[key]] = (m[s[key]] || 0) + 1), m), {}))
    .map(([k, v]) => `${k || '(不明)'} ${v}`)
    .join(' / ');
console.log(`\n合計 ${unique.length}店を data/stores.json に書き出しました`);
console.log(`チェーン別：${count('chain')}`);
console.log(`都道府県別：${count('pref')}`);
console.log(`公式ページの緯度・経度を使えた店：${official}店（残りは npm run geocode で住所から変換）`);
const noPref = unique.filter((s) => !s.pref);
if (noPref.length) console.log(`\n▼ 住所に都道府県がない店（地図にする前に確認）\n${noPref.map((s) => ` - ${s.name}：${s.address}`).join('\n')}`);
