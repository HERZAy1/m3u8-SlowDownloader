import type { Playlist, Segment } from './types.ts';

export class PlaylistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistError';
  }
}

/** 单个播放列表允许的最大分片数，防止异常清单耗尽内存/磁盘。 */
const MAX_SEGMENTS = 100_000;

/** 本工具只处理静态 VOD；直播/事件列表必须显式拒绝，不能静默只下一次。 */
export function assertVod(playlist: Playlist): void {
  if (!playlist.isVod) {
    throw new PlaylistError(
      '这是直播/非点播播放列表（缺少 #EXT-X-ENDLIST 或 #EXT-X-PLAYLIST-TYPE:VOD），本工具只支持静态 VOD',
    );
  }
}

/**
 * 解析 media playlist。
 *
 * 明确不支持的三类列表会直接抛错并说明原因，而不是静默降级——
 * 静默降级会在 3 小时后才暴露为"输出文件损坏"。
 */
export function parsePlaylist(text: string, baseUrl: string): Playlist {
  const lines = text.split(/\r?\n/);
  const segments: Segment[] = [];
  const variants: string[] = [];

  let pendingDuration = 0;
  let pendingDiscontinuity = false;
  let discontinuityCount = 0;
  let isVod = false;
  let sawHeader = false;
  let sawStreamInf = false;
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // HLS 清单必须以 #EXTM3U 开头；没有它时任意文本都会被误当成“分片”。
    if (!sawHeader) {
      if (line !== '#EXTM3U') {
        throw new PlaylistError('不是有效的 m3u8：缺少 #EXTM3U 文件头');
      }
      sawHeader = true;
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      sawStreamInf = true;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-SESSION-KEY')) {
      const method = /METHOD\s*=\s*([^,\s]+)/i.exec(line)?.[1]?.toUpperCase();
      // METHOD=NONE 只是“不加密”的标记，不应像真正的加密清单一样报错。
      if (method !== 'NONE') {
        throw new PlaylistError('列表包含加密密钥（#EXT-X-KEY），本工具不支持（决策 D4）');
      }
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      throw new PlaylistError('列表包含 #EXT-X-MAP（fMP4 分片），本工具仅支持 TS（决策 D5）');
    }

    if (line.startsWith('#EXT-X-BYTERANGE')) {
      throw new PlaylistError(
        '列表包含 #EXT-X-BYTERANGE（字节范围分片），本工具不支持；请改用普通 TS 分片列表',
      );
    }

    if (line.startsWith('#EXT-X-PLAYLIST-TYPE')) {
      if (/:VOD\b/i.test(line)) isVod = true;
      continue;
    }

    if (line === '#EXT-X-DISCONTINUITY') {
      pendingDiscontinuity = true;
      discontinuityCount += 1;
      continue;
    }

    if (line === '#EXT-X-ENDLIST') {
      isVod = true;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const matched = /^#EXTINF:\s*([0-9.]+)/.exec(line);
      pendingDuration = matched ? Number.parseFloat(matched[1] as string) : 0;
      continue;
    }

    if (line.startsWith('#')) continue;

    // 非注释行 = URI
    if (sawStreamInf) {
      variants.push(new URL(line, baseUrl).toString());
      continue;
    }

    if (!(pendingDuration > 0)) {
      throw new PlaylistError(`分片 ${line} 缺少有效的 #EXTINF 时长`);
    }
    if (segments.length >= MAX_SEGMENTS) {
      throw new PlaylistError(`播放列表分片数量超过上限（${MAX_SEGMENTS}）`);
    }

    index += 1;
    segments.push({
      index,
      uri: new URL(line, baseUrl).toString(),
      duration: pendingDuration,
      discontinuity: pendingDiscontinuity,
    });
    pendingDiscontinuity = false;
    pendingDuration = 0;
  }

  if (!sawHeader) {
    throw new PlaylistError('不是有效的 m3u8：缺少 #EXTM3U 文件头');
  }

  if (variants.length > 0) {
    throw new PlaylistError(
      `这是主播放列表（master），包含 ${variants.length} 个码率变体。本工具只接受 media playlist，请改用具体变体地址：\n  ${variants.join('\n  ')}`,
    );
  }

  if (segments.length === 0) {
    throw new PlaylistError('未解析到任何分片，目标可能不是有效的 m3u8');
  }

  const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0);

  return { segments, totalDuration, isVod, discontinuityCount };
}

export function formatDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.round(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}
