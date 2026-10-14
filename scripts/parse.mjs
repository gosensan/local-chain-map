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

// --- よってって：店舗の一覧はJSON。住所などは各店のページ（npm run fetch:detail で保存）から読む ---
// JSONの形：{ wakayama: [{ name, url, ... }], osaka: [...], nara: [...], hyogo: [...], honsha: [...] }
// honsha は本社と集配センターなので店舗ではない
const YOTTETTE_BASE = 'https://www.yottette.jp';
const YOTTETTE_PREF = { wakayama: '和歌山県', osaka: '大阪府', nara: '奈良県', hyogo: '兵庫県' };

function parseYottette(json) {
  const data = JSON.parse(json);
  const stores = [];
  for (const [area, list] of Object.entries(data)) {
    if (area === 'honsha' || !Array.isArray(list)) continue;
    for (const item of list) {
      if (!item?.name || !item?.url) continue;
      stores.push({
        chain: 'よってって',
        format: 'よってって',
        name: `よってって ${item.name}`,
        address: '',
        postal: '',
        phone: '',
        hours: '',
        url: new URL(item.url, YOTTETTE_BASE).href,
        prefHint: YOTTETTE_PREF[area] ?? '', // 住所に県名が書かれていない店のため
      });
    }
  }
  return stores;
}

// 店舗ページは「住所 〒649-1342 和歌山県…」「TEL 0738-…」「営業時間 9:00～18:30」のように1行ずつ書かれている
function linesOf(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  $('p, li, div, dt, dd, tr, td, th, h1, h2, h3, h4, h5, section').each((_, el) => $(el).append('\n'));
  return $('body').text().split('\n').map(clean).filter(Boolean);
}
function valueOf(lines, label, test = () => true) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(label)) continue;
    const v = lines[i].slice(label.length).replace(/^[\s:：.]+/, '') || lines[i + 1] || '';
    if (test(v)) return v;
  }
  return '';
}
function fillYottette(s, html) {
  const lines = linesOf(html);
  // 「住所 〒640-8454 和歌山市ふじと台23番地 …」のように県名がない店もある
  const addr = valueOf(lines, '住所', (v) => /^(〒\s*\d{3}-\d{4}\s*)?[^\s（(]+?[市区町村郡].*\d/.test(v));
  const m = addr.match(/^(?:〒\s*(\d{3}-\d{4})\s*)?(.+)$/);
  if (m) {
    s.postal = m[1] ? `〒${m[1]}` : '';
    s.address = prefOf(m[2]) ? m[2] : `${s.prefHint}${m[2]}`;
  }
  delete s.prefHint;
  s.phone = valueOf(lines, 'TEL', (v) => /^[\d-]{10,13}/.test(v)).match(/^[\d-]+/)?.[0] ?? '';
  // 営業時間は「1F：…」「2F：…」と複数行のことがあるので、次の項目が始まるまでつなげる
  const i = lines.findIndex((l) => l.startsWith('営業時間'));
  if (i >= 0) {
    const parts = [lines[i].slice(4).replace(/^[\s:：]+/, '')];
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      if (/^(住所|TEL|FAX|定休|年中|駐車場|※)/.test(lines[j]) || !/\d{1,2}:\d{2}/.test(lines[j])) break;
      parts.push(lines[j]);
    }
    s.hours = parts.filter(Boolean).join(' / ');
  }
}

// --- 実行 ---
const files = (await readdir(RAW)).filter((f) => f.endsWith('.html') || f.endsWith('.json')).sort();
const all = [];
for (const f of files) {
  const html = decode(await readFile(new URL(f, RAW)));
  let stores = [];
  if (f.startsWith('okuwa-')) {
    stores = parseOkuwa(html, `https://www.okuwa.net/store/${f.replace('okuwa-', '')}`);
  } else if (f.startsWith('hirooka-')) {
    stores = parseHirooka(html);
  } else if (f.startsWith('yottette-')) {
    stores = parseYottette(html);
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
// 店舗ページ・地図ページ（npm run fetch:detail で保存したもの）があれば、そこから正確な緯度・経度を取る
// よってっては住所・電話・営業時間も店舗ページから読む
let official = 0;
let noDetail = 0;
const unread = [];
for (const s of unique) {
  const page =
    s.chain === 'オークワ' ? s.mapUrl : s.chain === 'よってって' || s.url.includes('/tenpo/') ? s.url : '';
  if (!page) continue;
  try {
    const bytes = await readFile(new URL(`detail/${keyOf(page)}.html`, RAW));
    if (s.chain === 'よってって') {
      fillYottette(s, decode(bytes));
      if (!s.address) unread.push(s);
    }
    const c = findCoords(bytes.toString('latin1'));
    if (c) {
      s.lat = c.lat;
      s.lng = c.lng;
      s.coordSource = c.kind === 'embed' ? 'embed' : 'official';
      official++;
    }
  } catch {
    // まだ取ってきていない店は、あとで住所から変換する
    if (s.chain === 'よってって') noDetail++;
  }
}
unique.forEach((s, i) => {
  s.id = `store-${String(i + 1).padStart(3, '0')}`;
  s.pref = prefOf(s.address);
});

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
if (noDetail) console.log(`\n▼ よってって：店舗ページが未取得の店が ${noDetail}店あります。npm run fetch:detail → npm run parse を実行してください`);
if (unread.length) console.log(`\n▼ よってって：店舗ページはあるが住所を読み取れなかった店（${unread.length}店）\n${unread.map((s) => ` - ${s.name}：${s.url}`).join('\n')}`);
const noPref = unique.filter((s) => !s.pref && s.address);
if (noPref.length) console.log(`\n▼ 住所に都道府県がない店（地図にする前に確認）\n${noPref.map((s) => ` - ${s.name}：${s.address}`).join('\n')}`);
