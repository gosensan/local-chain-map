// 店舗ページや地図ページのHTMLから緯度・経度を探す共通の部品
//
// Googleマップの埋め込み（q=34.07, 135.11）や、地図のプログラム（LatLng(34.07, 135.11)）など、
// 書き方はサイトによって違う。そこで「日本の緯度(24〜46)と経度(122〜154)が並んでいる所」を探す。

const PAIR = /(?<![\d.])(2[4-9]|3\d|4[0-6])\.(\d{3,})\s*(?:,|%2C|&amp;lng=|&lng=)\s*(1[2-5]\d)\.(\d{3,})/;

export function findCoords(html) {
  const m = html.match(PAIR);
  if (!m) return null;
  const lat = parseFloat(`${m[1]}.${m[2]}`);
  const lng = parseFloat(`${m[3]}.${m[4]}`);
  if (lng < 122 || lng > 154) return null;
  return { lat, lng };
}

// 保存ファイル名に使う短い名前（URLから作る）
import { createHash } from 'node:crypto';
export const keyOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);
