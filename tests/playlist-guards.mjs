/**
 * 播放列表边界回归：缺失 #EXTM3U、直播、BYTERANGE、KEY METHOD=NONE。
 *
 * 用法：node tests/playlist-guards.mjs
 */
import { assertVod, parsePlaylist } from '../src/playlist.ts';

let passed = 0;
let failed = 0;

function check(ok, label, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${extra ? `  ${extra}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${extra ? `  ${extra}` : ''}`);
  }
}

function throws(text, label) {
  try {
    parsePlaylist(text, 'https://example.com/play.m3u8');
    check(false, label, '未抛错');
  } catch (err) {
    check(true, label, err.message);
  }
}

const base = 'https://example.com/play.m3u8';

const vod = parsePlaylist(
  '#EXTM3U\n#EXTINF:10,\na.ts\n#EXTINF:11,\nb.ts\n#EXT-X-ENDLIST\n',
  base,
);
check(vod.segments.length === 2 && vod.isVod, '正常 VOD 解析', `${vod.segments.length} 片`);

throws('#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n', '缺少 #EXTM3U 被拒绝');

const live = parsePlaylist('#EXTM3U\n#EXTINF:1,\na.ts\n', base);
check(!live.isVod, '无 ENDLIST 被识别为非 VOD');
try {
  assertVod(live);
  check(false, '直播列表被 assertVod 拒绝', '未抛错');
} catch (err) {
  check(true, '直播列表被 assertVod 拒绝', err.message);
}

const vodType = parsePlaylist('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:1,\na.ts\n', base);
try {
  assertVod(vodType);
  check(true, '#EXT-X-PLAYLIST-TYPE:VOD 被接受');
} catch (err) {
  check(false, '#EXT-X-PLAYLIST-TYPE:VOD 被接受', err.message);
}

throws(
  '#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:100@0\na.ts\n#EXT-X-ENDLIST\n',
  'BYTERANGE 被明确拒绝',
);

const keyNone = parsePlaylist(
  '#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n',
  base,
);
check(keyNone.segments.length === 1, 'KEY METHOD=NONE 不误报');

throws(
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST\n',
  'AES-128 被拒绝',
);

throws('#EXTM3U\n#EXTINF:1,\na.ts\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-ENDLIST\n', 'EXT-X-MAP 被拒绝');

throws('#EXTM3U\na.ts\n#EXT-X-ENDLIST\n', '缺少 EXTINF 被拒绝');

throws(
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n',
  'master playlist 被拒绝',
);

throws('#EXTM3U\n', '空播放列表被拒绝');

console.log(`\n${passed}/${passed + failed} 项通过`);
if (failed > 0) {
  console.log('有失败项 ❌');
  process.exit(1);
}
console.log('全部通过 ✅');
process.exit(0);
