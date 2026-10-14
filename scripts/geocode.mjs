// ステップ3：緯度・経度がまだない店について、住所から位置を調べ、地図用の src/data/stores.json を作るスクリプト
// 使い方：npm run geocode
//
// - 公式ページから緯度・経度を取れた店（npm run fetch:detail → npm run parse）は、そのまま使う
// - それ以外は国土地理院の住所検索で調べる（0.3秒おきに1件ずつ）
// - 調べた結果は data/geocode-cache.json に保存し、次回からは同じ住所を調べ直さない
// - 地番の住所などで番地まで見つからないときは、町の中心を「おおよその位置」として使う
// - 県の範囲から外れた結果は明らかな間違いなので地図に載せず、一覧で知らせる
// - 位置を手で直したいときは data/geocode-fix.json に {"店名": [緯度, 経度]}（住所でも可）と書く

import { readFile, writeFile } from 'node:fs/promises';

const IN = new URL('../data/stores.json', import.meta.url);
const CACHE = new URL('../data/geocode-cache.json', import.meta.url);
const FIX = new URL('../data/geocode-fix.json', import.meta.url);
const OUT = new URL('../src/data/stores.json', import.meta.url);
const API = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q=';

// 各府県のおおよその範囲 [南, 北, 西, 東]。ここから外れた結果は間違いとみなす
const PREF_BOX = {
  和歌山県: [33.4, 34.4, 135.0, 136.1],
  大阪府: [34.25, 35.06, 135.08, 135.75],
  奈良県: [33.85, 34.79, 135.53, 136.24],
  三重県: [33.72, 35.26, 135.85, 136.99],
  愛知県: [34.57, 35.43, 136.67, 137.84],
  岐阜県: [35.13, 36.47, 136.27, 137.66],
  静岡県: [34.57, 35.65, 137.47, 139.18],
  兵庫県: [34.15, 35.68, 134.25, 135.47],
};
const inPref = (pref, lat, lng) => {
  const b = PREF_BOX[pref];
  return !b || (lat >= b[0] && lat <= b[1] && lng >= b[2] && lng <= b[3]);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = async (u, fallback) => {
  try {
    return JSON.parse(await readFile(u, 'utf-8'));
  } catch {
    return fallback;
  }
};
const toHalf = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[−－ー―‐]/g, '-');

// 検索用の住所：番地より後ろ（建物名など）を外す
const searchAddress = (addr) => {
  const s = toHalf(addr).split(/[\s　]+/)[0];
  const m = s.match(/^.*?[0-9]+(?:(?:丁目|番地|番|号|-)[0-9]*)*/);
  return m ? m[0].replace(/-$/, '') : s;
};
const townOf = (q) => q.replace(/[0-9].*$/, ''); // 例：和歌山県西牟婁郡上富田町生馬
// 市町村まで（例：和歌山県西牟婁郡上富田町）。町名でも見つからないときの最後の手段
const cityOf = (q) => q.match(/^.+?(?:郡.+?[町村]|市.+?区|市|区|町|村)/)?.[0] ?? '';
// 「ヶ・ケ・が」などの書き方の違いで一致しないのを防ぐ
const norm = (s) => s.replace(/大?字/g, '').replace(/[ヶケヵカが]/g, 'ケ').replace(/[ノの之]/g, 'ノ').replace(/\s/g, '');
const startsWith = (title, head) => norm(title).startsWith(norm(head));

const stores = await readJson(IN, null);
if (!stores) throw new Error('data/stores.json がありません。先に npm run parse を実行してください');
const cache = await readJson(CACHE, {});
// 手入力の位置。書き間違いがあっても黙って無視せず、どこが悪いかを表示する
const fix = {};
const fixUsed = new Set();
{
  let text = null;
  try {
    text = (await readFile(FIX, 'utf-8')).replace(/^\uFEFF/, '');
  } catch {
    // ファイルがなければ手入力なし
  }
  if (text != null) {
    // よくある書き間違いを直してから読む：全角の記号、最後の項目の後ろのカンマ
    const cleaned = text
      .replace(/[，、]/g, ',')
      .replace(/[．]/g, '.')
      .replace(/[［]/g, '[')
      .replace(/[］]/g, ']')
      .replace(/[“”]/g, '"')
      .replace(/,\s*([}\]])/g, '$1');
    let raw;
    try {
      raw = JSON.parse(cleaned);
    } catch {
      // JSONとして読めないとき（[ ] なしで貼った場合など）は、1行ずつ「"店名": 緯度, 経度」を読む
      raw = {};
      for (const line of cleaned.split(/\r?\n/)) {
        const m = line.match(/"([^"]+)"\s*:\s*(.+)$/);
        if (m) raw[m[1]] = m[2].trim() === 'null' || m[2].trim() === 'null,' ? null : m[2];
      }
    }
    for (const [k, v] of Object.entries(raw)) {
      if (v == null) continue;
      // [33.88, 135.15] でも "33.88, 135.15" でも受け付ける
      const nums = (Array.isArray(v) ? v.join(',') : String(v)).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length !== 2 || nums[0] < 20 || nums[0] > 46 || nums[1] < 122 || nums[1] > 154) {
        console.log(`✖ geocode-fix.json の「${k}」の値が緯度・経度になっていません：${JSON.stringify(v)}`);
        continue;
      }
      fix[k.trim()] = nums;
    }
  }
}

let asked = 0;
async function lookup(q) {
  if (cache[q]) return cache[q];
  if (asked > 0) await sleep(300);
  asked++;
  process.stdout.write(`\r住所を検索中… ${asked}件`);
  const res = await fetch(API + encodeURIComponent(q));
  const hit = (await res.json())[0];
  cache[q] = hit
    ? { lng: hit.geometry.coordinates[0], lat: hit.geometry.coordinates[1], title: toHalf(hit.properties.title) }
    : { notFound: true };
  return cache[q];
}

// 住所から位置を調べる。見つからなければ null、番地まで合わなければ approx: true
async function fromAddress(s) {
  const q = searchAddress(s.address);
  const town = townOf(q);
  let c = await lookup(q);
  let approx = false;
  let head = town;
  if (c.notFound || !startsWith(c.title, town)) {
    // 町名すら合っていない ＝ 別の場所。町の中心で検索し直す
    c = await lookup(town);
    approx = true;
    if (c.notFound || !startsWith(c.title, town)) {
      // 町名でもだめなら、市町村の中心
      head = cityOf(q);
      c = head ? await lookup(head) : { notFound: true };
    }
  } else if (!/[0-9]/.test(norm(c.title).slice(norm(town).length))) {
    approx = true; // 町名は合っているが番地までは見つからなかった
  }
  if (c.notFound || !head || !startsWith(c.title, head) || !inPref(s.pref, c.lat, c.lng)) return null;
  return { lat: c.lat, lng: c.lng, approx };
}

// 2点間のおおよその距離（km）
const distKm = (a, b) => {
  const dy = (a.lat - b.lat) * 111;
  const dx = (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

const tally = { official: 0, embed: 0, embedToAddress: 0, exact: 0, approx: 0, fixed: 0 };
const approxList = [];
const embedList = [];
const dropped = [];

for (const s of stores) {
  // 手入力の位置（店名か住所で指定）がいちばん優先
  const key = fix[s.name] ? s.name : fix[s.address] ? s.address : null;
  const f = key && fix[key];
  if (f) {
    fixUsed.add(key);
    [s.lat, s.lng] = f;
    s.coordSource = 'manual';
    tally.fixed++;
    continue;
  }
  if (s.coordSource === 'official') {
    tally.official++;
    continue;
  }
  if (!s.address) {
    dropped.push(`${s.name}：住所が分かりません（npm run fetch:detail → npm run parse を実行）`);
    continue;
  }
  try {
    const a = await fromAddress(s);
    if (s.coordSource === 'embed') {
      // 埋め込み地図の位置は「地図の中心」で、ピンから少しずれていることがある。
      // 住所が番地まで見つかり、しかも近く（2km以内）なら、住所の位置のほうを使う
      if (a && !a.approx && distKm(a, s) < 2) {
        s.lat = a.lat;
        s.lng = a.lng;
        s.coordSource = 'address';
        tally.embedToAddress++;
      } else {
        tally.embed++;
        embedList.push(`${s.name}：${s.address}`);
      }
      continue;
    }
    if (!a) {
      dropped.push(`${s.name}：${s.address}`);
      continue;
    }
    s.lat = a.lat;
    s.lng = a.lng;
    s.coordSource = a.approx ? 'approx' : 'address';
    if (a.approx) {
      tally.approx++;
      approxList.push(`${s.name}：${s.address}`);
    } else {
      tally.exact++;
    }
  } catch (e) {
    if (s.lat == null) dropped.push(`${s.name}：検索に失敗（${e.message}）`);
  }
}
if (asked) console.log('');

await writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');

const placed = stores.filter((s) => s.lat != null);
const updatedAt = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
await writeFile(OUT, JSON.stringify({ updatedAt, stores: placed }, null, 2) + '\n');

console.log(`${placed.length} / ${stores.length} 店を src/data/stores.json に書き出しました`);
console.log(`  公式ページの位置（ピン）：${tally.official}店`);
if (tally.embed || tally.embedToAddress) {
  console.log(`  公式ページの埋め込み地図 → 住所の位置に置き換え：${tally.embedToAddress}店`);
  console.log(`  公式ページの埋め込み地図の中心のまま：${tally.embed}店`);
}
console.log(`  住所から（番地まで一致）：${tally.exact}店`);
console.log(`  住所から（町の中心＝おおよその位置）：${tally.approx}店`);
console.log(`  手入力（geocode-fix.json）：${tally.fixed}店`);
const unusedFix = Object.keys(fix).filter((k) => !fixUsed.has(k));
if (unusedFix.length) {
  console.log(`\n▼ geocode-fix.json に書いたが、同じ名前の店が見つからなかったもの（店名を確認してください）`);
  for (const k of unusedFix) console.log(` - 「${k}」`);
}
if (approxList.length) {
  console.log(`\n▼ おおよその位置の店（地図では「おおよその位置」と表示されます）`);
  for (const a of approxList) console.log(' - ' + a);
}
if (embedList.length) {
  console.log(`\n▼ 埋め込み地図の中心を使った店（少しずれていることがあります。気になる店は手入力で直せます）`);
  for (const a of embedList) console.log(' - ' + a);
}
if (dropped.length) {
  console.log(`\n▼ 位置が分からず地図に載せなかった店`);
  for (const d of dropped) console.log(' - ' + d);
}
if (dropped.length || embedList.length) {
  console.log('\n位置を手で直すには、data/geocode-fix.json に {"店名": [緯度, 経度]} を書いて再実行してください');
  console.log('（緯度・経度は、Googleマップで店のピンを右クリックすると一番上に出る数字をクリックでコピーできます）');
}
