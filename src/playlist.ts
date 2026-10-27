import type { Playlist, Segment } from './types.ts';

export class PlaylistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaylistError';
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
  let sawStreamInf = false;
  let index = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      sawStreamInf = true;
      continue;
    }

    if (line.startsWith('#EXT-X-KEY')) {
      throw new PlaylistError('列表包含 #EXT-X-KEY（加密分片），本工具不支持（决策 D4）');
    }

    if (line.startsWith('#EXT-X-MAP')) {
      throw new PlaylistError('列表包含 #EXT-X-MAP（fMP4 分片），本工具仅支持 TS（决策 D5）');
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
