// 店舗ページや地図ページのHTMLから緯度・経度を探す共通の部品
//
// Googleマップの埋め込み（q=34.07, 135.11）や、地図のプログラム（LatLng(34.07, 135.11)）など、
// 書き方はサイトによって違う。そこで「日本の緯度(24〜46)と経度(122〜154)が並んでいる所」を探す。

const PAIR = /(?<![\d.])(2[4-9]|3\d|4[0-6])\.(\d{3,})\s*(?:,|%2C|&amp;lng=|&lng=)\s*(1[2-5]\d)\.(\d{3,})/;
// Googleマップの埋め込み（共有→地図を埋め込む）の書き方：…!2d経度!3d緯度…（経度が先）
const EMBED = /!2d(1[2-5]\d\.\d{3,})!3d((?:2[4-9]|3\d|4[0-6])\.\d{3,})/;

// kind: 'pin' はお店の位置そのもの、'embed' は埋め込み地図の「中心」（ピンから少しずれることがある）
export function findCoords(html) {
  const m = html.match(PAIR);
  if (m) {
    const lat = parseFloat(`${m[1]}.${m[2]}`);
    const lng = parseFloat(`${m[3]}.${m[4]}`);
    if (lng >= 122 && lng <= 154) return { lat, lng, kind: 'pin' };
  }
  const e = html.match(EMBED);
  if (e) return { lat: parseFloat(e[2]), lng: parseFloat(e[1]), kind: 'embed' };
  return null;
}

// 保存ファイル名に使う短い名前（URLから作る）
import { createHash } from 'node:crypto';
export const keyOf = (url) => createHash('sha1').update(url).digest('hex').slice(0, 12);
