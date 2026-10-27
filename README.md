# m3u8 Downloader

按 `#EXTINF` 节奏缓速下载 HLS 点播，输出原始 `.ts`。用于以接近真实观看的节奏取回自己有权访问的课程回放。

## 特性

- **节拍调度**：采用绝对时间轴，第 i 片的计划时刻 = `t0 + (Σ EXTINF[0..i-1]) / speed`。总耗时 ≈ 视频时长 / 倍速，与网速无关，误差不累积。
- **零依赖**：只用 Node 内置能力（`fetch`、`node:fs`、`node:path`），无 `node_modules`。
- **无编译步骤**：Node ≥ 22.6 直接执行 TypeScript（类型擦除），`node src/cli.ts` 即可。
- **断点续传**：分片按序号独立落盘，重跑自动跳过已完成的。
- **HTTP 层可替换**：调度器只依赖 `HttpClient` 接口，将来换 TLS 指纹实现不动调度逻辑。

## 环境

Node.js ≥ 22.6（推荐 24+，原生 TS 执行默认开启）。

## 用法

```bash
node src/cli.ts <m3u8-url> [选项]
```

| 选项 | 说明 | 默认 |
|---|---|---|
| `--out <dir>` | 输出目录 | `downloads/<任务名>` |
| `--speed <n>` | 倍速；`0` 表示关闭节拍全速下载 | `2` |
| `--jitter <ms>` | 计划时刻的随机抖动 | `300` |
| `--retries <n>` | 单分片重试次数 | `3` |
| `--resume <mode>` | `fast` 跳过已下载 / `pace` 保持节奏 | `fast` |
| `--limit <n>` | 只下载前 n 片（调试） | 全部 |
| `--no-merge` | 下载完不拼接 | 拼接 |
| `--remux` | 拼接后用 ffmpeg 重建时间戳 | 关闭 |
| `--dry-run` | 只解析并打印统计 | — |
| `--quiet` | 不打印进度行 | — |

### 示例

```bash
# 先看清单结构，不下载
node src/cli.ts "https://example.com/play.m3u8" --dry-run

# 2 倍速完整下载
node src/cli.ts "https://example.com/play.m3u8" --speed 2

# 调试：只下 5 片，20 倍速
node src/cli.ts "https://example.com/play.m3u8" --limit 5 --speed 20 --out ./tmp
```

## GUI

```bash
node src/server.ts        # 或 npm run gui
```

浏览器打开 <http://127.0.0.1:7788>。

页面提供：URL 输入、倍速 / 抖动 / 重试 / 限片参数、输出目录、进度条与 ETA、暂停 / 继续 / 取消，以及一个 **CLI 风格的终端面板**——每个分片完成时实时输出一行（时间 / 序号 / 百分比 / 大小 / 耗时），重试与失败以不同颜色标注，自动跟随最新并限制在 4000 行以内。

**任务完成后页面会出现「下载文件」按钮**，点击即以附件形式下载合并好的 `.ts`（`GET /api/download`），不需要去翻本地目录。文件仍会保留在输出目录中，可自行清理。

前后端通过 HTTP + SSE 通信，前端是原生 HTML/CSS/JS，**无构建步骤、无框架**。若将来需要独立 exe，用 Electron 套壳即可，UI 代码原样复用。

服务只监听 `127.0.0.1`，不对外暴露。端口可用 `PORT` 环境变量覆盖。

## 输出结构

```
downloads/<任务名>/
├── playlist.m3u8        # 原始列表快照
├── state.json           # 任务状态
├── segments/0001.ts …   # 分片
└── output.ts            # 拼接产物
```

## 关于 `--remux`

分片列表里的 `#EXT-X-DISCONTINUITY` 会让 TS 时间戳跳变。多数播放器可容忍，若出现音画不同步，用 `--remux` 让 ffmpeg 以 `-fflags +genpts` 重建时间轴，产出 `output.fixed.ts`。需要系统已安装 ffmpeg。

## 边界

- 仅支持 **media playlist**（不解析 master / 多码率），遇到会报错并列出变体地址。
- 仅支持**未加密**的 TS 分片；遇到 `#EXT-X-KEY` 或 `#EXT-X-MAP` 会直接报错，不做静默降级。
- 仅支持静态点播（`#EXT-X-ENDLIST`），不做直播轮询。
- 不涉及任何 DRM。

## 类型检查（可选）

源码本身不需要编译。若想在编辑器里获得完整类型提示：

```bash
pnpm add -D typescript @types/node
pnpm exec tsc --noEmit
```
