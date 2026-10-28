# m3u8 Downloader

按 `#EXTINF` 节奏缓速下载 HLS 点播流，输出原始 `.ts`。

用于以**接近真实观看的节奏**取回自己有权访问的课程回放——不是"尽可能快地扒站"，而是模拟一个正常播放器在正常播放。

> ⚠️ **本项目仅供个人学习与备份使用。** 请仅下载你有权访问的内容，遵守目标平台的服务条款与当地法律。作者不对任何滥用行为负责。使用前请阅读[免责声明](#免责声明)。

---

## 目录

- [这是什么](#这是什么)
- [特性](#特性)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [GUI 使用](#gui-使用)
- [命令行参数](#命令行参数)
- [输出结构](#输出结构)
- [工作原理](#工作原理)
- [HTTP 接口](#http-接口)
- [边界与限制](#边界与限制)
- [常见问题](#常见问题)
- [项目结构](#项目结构)
- [开发](#开发)
- [免责声明](#免责声明)
- [许可证](#许可证)

---

## 这是什么

一个零依赖的 Node.js 工具，做三件事：

1. 解析 m3u8 播放列表，读出每个分片的 `#EXTINF` 时长；
2. 按 **绝对时间轴** 逐片下载——第 i 片的计划时刻是 `t0 + (Σ EXTINF[0..i-1]) / speed`，所以总耗时 ≈ 视频时长 ÷ 倍速，与网速无关，误差不累积；
3. 把分片按序二进制拼接成单一 `.ts` 文件。

提供两种入口：**本地 Web GUI**（推荐）和 **CLI**。两者共用同一套核心。

---

## 特性

| 特性 | 说明 |
|---|---|
| **节拍调度** | 绝对时间轴，不累积漂移；慢片不追赶，避免补偿性突发 |
| **倍速可调** | 默认 2x，支持 0.5–20x；`0` 表示关闭节拍全速下载 |
| **抖动** | 计划时刻加 ±300ms 随机偏移，默认开启，可调 |
| **断点续传** | 分片按序号独立落盘，重跑自动跳过已完成的 |
| **失败隔离** | 单片重试 3 次（指数退避），失败不阻塞后续分片 |
| **零依赖** | 只用 Node 内置能力，无 `node_modules`，无 `npm install` |
| **无编译** | Node ≥ 22.6 直接执行 TypeScript（类型擦除） |
| **HTTP 层可替换** | 调度器只依赖 `HttpClient` 接口，换 TLS 指纹实现时调度逻辑不动 |
| **浏览器交付** | 任务完成后页面直接下载成品，不用翻目录 |
| **下载队列** | 一次排队多个地址，串行执行；运行中可随时增删；结束后输出汇总报告 |
| **文件管理** | 定时扫描磁盘，列出每个任务的分片与成品占用、开始时间、耗时，可一键删除该任务全部文件 |

---

## 环境要求

| 依赖 | 必需 | 说明 |
|---|---|---|
| **Node.js ≥ 22.6** | ✅ | 需要原生 TypeScript 类型擦除；推荐 24+ |
| npm 包 | ❌ | 零依赖，无需安装 |
| ffmpeg | ⭕ | 仅 `--remux` 需要 |
| 浏览器 | ✅ | GUI 模式需要，任意现代浏览器 |

安装 Node（若尚未安装）：

```powershell
winget install OpenJS.NodeJS.LTS
```

---

## 快速开始

### 方式一：GUI（推荐）

**双击 `start.cmd`**。

脚本会：

1. 依次查找 Node.js（`PATH` → 常见安装位置 → 随附运行时）
2. 打印找到的 Node 路径与访问地址
3. 等 2 秒自动打开浏览器
4. 前台运行服务

关闭那个命令行窗口 = 停止服务。

可用的环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` | 监听端口 | `7788` |
| `NO_BROWSER=1` | 不自动打开浏览器 | — |

### 方式二：命令行

```powershell
cd "D:\m3u8 Downloader"
node src/server.ts          # 启动 GUI
node src/cli.ts <url> ...   # 直接用 CLI
```

---

## 部署到 Linux 服务器

在 Debian / Ubuntu 上以 systemd 服务常驻运行，含开机自启。

**1. 安装 Node.js**

```bash
VER=24.21.0
cd /tmp
wget -q https://nodejs.org/dist/v$VER/node-v$VER-linux-x64.tar.gz
wget -q https://nodejs.org/dist/v$VER/SHASUMS256.txt
sha256sum -c SHASUMS256.txt --ignore-missing
sudo mkdir -p /opt/node
sudo tar -xzf node-v$VER-linux-x64.tar.gz -C /opt/node --strip-components=1
sudo ln -sf /opt/node/bin/node /usr/local/bin/node
sudo ln -sf /opt/node/bin/npm /usr/local/bin/npm
```

**2. 部署代码**

把 `src/`、`web/`、`package.json` 传到 `/opt/m3u8-downloader`：

```bash
sudo mkdir -p /opt/m3u8-downloader
sudo tar -xzf m3u8dl.tar.gz -C /opt/m3u8-downloader
sudo chown -R debian:debian /opt/m3u8-downloader
sudo find /opt/m3u8-downloader -type d -exec chmod 755 {} \;
sudo find /opt/m3u8-downloader -type f -exec chmod 644 {} \;
```

**3. 安装 systemd 服务**

```bash
sudo cp deploy/m3u8-downloader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now m3u8-downloader
```

**4. 验证**

```bash
systemctl status m3u8-downloader
wget -qO- http://127.0.0.1:7788/api/state
```

局域网内其他机器访问 `http://<服务器IP>:7788`。

> ⚠️ **安全提示**：服务默认只绑 `127.0.0.1`；单元文件里通过 `HOST=0.0.0.0` 对外开放，且**没有任何登录认证**。请只在可信网络内使用，或改用 SSH 隧道：
>
> ```bash
> ssh -L 7788:127.0.0.1:7788 user@server
> ```
>
> 并把单元文件里的 `Environment=HOST=0.0.0.0` 删掉。

---

## GUI 使用

启动后访问 <http://127.0.0.1:7788>（仅监听 `127.0.0.1`，外网不可达）。

**操作流程**：

1. 在地址框里粘贴一个或多个 m3u8 地址，**每行一个**
2. 设定倍速（默认 2）、抖动、重试次数，可选填输出目录和"只下前 N 片"
3. 点「加入队列」先排着，或直接点「开始队列」立即开跑
4. 队列按顺序串行执行，终端面板逐片实时输出（多任务时每行带 `[序号]` 前缀）
5. 每个任务完成后，队列行上出现「下载」和「清理」按钮
6. 全部结束后，终端打印**汇总报告**：每个链接的成败、分片数、体积、耗时，以及失败链接**缺失的具体分片区间**

**快捷操作**：

| 操作 | 效果 |
|---|---|
| `Enter`（光标在输入框内） | 开始下载 |
| `Esc` | 取消当前任务 |
| 点 `1x / 2x / 4x / 8x` | 快速设定倍速 |

除「只下前 N 片」外，所有参数与地址都会记在浏览器 `localStorage` 里，下次打开自动回填。参数在任务运行期间锁定，避免中途改倍速造成节奏错乱。

**终端面板**分两部分：

1. **顶部固定进度条** —— 实时更新整体进度，不刷屏：

```
[████████░░░░░░░░░░░░]  38.4%
412/1074 · 已用 00:31:02 · 剩余 00:49:12 · 1.2 GB
```

2. **下方滚动区** —— 只输出失败分片和里程碑事件：

```
14:02:11  清单解析完成  1074 片  02:56:04  203 个断点  静态点播
14:05:01  ✗  #412 HTTP 500（共 4 次尝试）
14:31:07  任务完成  00:58:44  571.0 MB  /opt/…/output.ts
```

重试不会刷屏，只在进度条右侧短暂显示「#412 第 2 次重试」，成功后自动消失。

- 滚动到底部时自动跟随；手动往上翻则不打断
- 上限 4000 行，超出丢弃最早的（防长任务内存膨胀）

**文件面板**每 5 秒自动扫描一次磁盘，列出所有**仍有文件**的任务：

```
play-1785390974218   分片 1074 个 · 542.3 MB　成品 571.0 MB   10-28 17:14 起 · 用时 01:34:02   [删除全部]
```

- 分片与成品分开显示，没有成品会标注「无成品」
- 「删除全部」会连分片、成品、`state.json` 一起删掉整个任务目录，不可恢复

**队列总览**在队列标题栏显示所有任务的预计总时长和整体完成百分比——入队时会自动探测每个播放列表的总时长，按各自的倍速折算后求和。

**按钮**：

| 按钮 | 行为 |
|---|---|
| 开始下载 | 启动任务（同一时间只允许一个任务） |
| 暂停 / 继续 | 暂停时长会计入时间轴，恢复后不会集中补发 |
| 取消 | 停止任务，已下载分片保留 |
| 下载文件 | 以附件形式下载合并好的 `.ts` |
| 清理分片 | 删除 `segments/` 释放空间，保留成品；删除后无法续传 |

---

## 命令行参数

```bash
node src/cli.ts <m3u8-url> [选项]
```

| 选项 | 说明 | 默认 |
|---|---|---|
| `--out <dir>` | 输出目录 | `downloads/<任务名>` |
| `--speed <n>` | 倍速；`0` 关闭节拍全速下载 | `2` |
| `--jitter <ms>` | 计划时刻的随机抖动 | `300` |
| `--retries <n>` | 单分片重试次数 | `3` |
| `--resume <mode>` | `fast` 跳过已下载 / `pace` 保持节奏 | `fast` |
| `--limit <n>` | 只下载前 n 片（调试） | 全部 |
| `--no-merge` | 下载完不拼接 | 拼接 |
| `--remux` | 拼接后用 ffmpeg 重建时间戳 | 关闭 |
| `--dry-run` | 只解析并打印统计，不下载 | — |
| `--quiet` | 不打印进度行 | — |

**示例**

```bash
# 先看清单结构，不下载
node src/cli.ts "https://example.com/play.m3u8" --dry-run

# 2 倍速完整下载
node src/cli.ts "https://example.com/play.m3u8" --speed 2

# 调试：只下 5 片，20 倍速
node src/cli.ts "https://example.com/play.m3u8" --limit 5 --speed 20 --out ./tmp
```

退出码：`0` 成功、`1` 出错、`2` 有分片失败、`130` 用户取消。

---

## 输出结构

```
downloads/<任务名>/
├── playlist.m3u8        # 原始列表快照（便于事后核对）
├── state.json           # 任务状态（URL、倍速、失败分片）
├── segments/0001.ts …   # 分片，序号即文件名
└── output.ts            # 拼接产物
```

拼接就是按序号做二进制顺序写入，不经过任何转码——字节数与分片之和完全相等。

---

## 工作原理

### 节拍调度

```
t0 = 开始时刻
for i in 0..n-1:
    deadline_i = t0 + (Σ_{j<i} EXTINF[j]) / speed
    actual_i   = deadline_i + jitter        # jitter ∈ [-300ms, +300ms]，独立采样
    sleep_until(actual_i)                   # 已过点则立即发出，不追赶
    fetch(segment_i)
```

三个关键决策：

1. **从请求发出时计时**，不是从下载完成。否则总耗时 = 视频时长 + Σ下载耗时，会系统性偏慢。
2. **绝对时间轴**，不是逐片累加睡眠。否则每片的误差会累积。
3. **慢片不追赶**。补偿性突发比匀速更不像真实播放器。

### 断点续传

- 分片按 `0001.ts`、`0002.ts` … 独立落盘
- 启动时扫描已存在的分片，`fast` 模式直接跳过，`pace` 模式仍按时间轴等待
- 暂停时长通过 `totalPausedMs` 平移进时间轴，恢复后不会集中补发

### 分层与可替换点

```
┌──────────────────────────────┐
│   Web GUI      │    CLI       │
├──────────────────────────────┤
│  DownloadTask（事件发射器）    │
├──────────────────────────────┤
│  Scheduler（节拍，纯逻辑）      │
├──────────────────────────────┤
│  HttpClient（接口）            │  ← 可替换点
│    └─ FetchHttpClient         │
├──────────────────────────────┤
│  PlaylistParser               │
└──────────────────────────────┘
```

`Scheduler` 只依赖 `HttpClient` 接口，不 import 任何具体 HTTP 库。将来若要把 `fetch` 换成 curl-impersonate / got-scraping 之类的 TLS 指纹实现，只需新增一个实现同一接口的类。

---

## HTTP 接口

GUI 后端只监听 `127.0.0.1`，接口如下：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | 页面 |
| `GET` | `/api/events` | SSE 事件流 |
| `GET` | `/api/state` | 当前状态与可用产物 |
| `POST` | `/api/start` | 兼容接口：入队并立即开始 |
| `GET` | `/api/queue` | 队列快照 || `POST` | `/api/queue` | `{urls: string[], ...参数}` 入队（自动去重、超上限拒绝） |
| `DELETE` | `/api/queue?id=` | 移除待处理项（运行中的不可删） |
| `POST` | `/api/queue/start` | 开始处理队列 |
| `POST` | `/api/queue/stop` | 停止队列（取消当前，保留待处理） |
| `POST` | `/api/queue/clear` | 清除已完成 / 失败 / 取消的记录 |
| `GET` | `/api/files` | 扫描磁盘上所有任务目录（分片 + 成品、开始时间、耗时） |
| `DELETE` | `/api/files?id=` | 删除该任务的全部文件（分片 + 成品 + 状态） |
| `POST` | `/api/control` | `{action: pause \| resume \| cancel}` |
| `GET` | `/api/download?task=<名>` | 下载成品（附件形式） |
| `POST` | `/api/cleanup` | `{task}` 删除分片目录 |

---

## 边界与限制

明确**不做**的事，且遇到时会直接报错而不是静默降级：

- ❌ **主播放列表（master / 多码率）** —— 只接受 media playlist，遇到会列出变体地址让你选
- ❌ **加密分片** —— 遇到 `#EXT-X-KEY` 直接报错
- ❌ **fMP4 分片** —— 遇到 `#EXT-X-MAP` 直接报错
- ❌ **直播流** —— 只处理带 `#EXT-X-ENDLIST` 的静态点播，不做轮询
- ❌ **DRM** —— 不涉及任何 Widevine / FairPlay / PlayReady 相关内容

静默降级会在三小时后才暴露成"文件损坏"，所以这里选择立刻失败。

---

## 常见问题

**Q：双击 start.cmd 提示找不到 Node.js**
装一个：`winget install OpenJS.NodeJS.LTS`。脚本会自动按 `PATH` → `%ProgramFiles%\nodejs` → `%LOCALAPPDATA%\Programs\nodejs` → scoop 的顺序查找。

**Q：端口 7788 被占用**
设环境变量 `PORT=7799` 后再启动。

**Q：下载的文件删不掉，提示"正由另一进程使用"**
服务进程正在读取它（通常是浏览器下载还没结束）。等下载完，或关掉服务窗口，句柄就会释放。

**Q：播放时音画不同步 / 断点处花屏**
列表里有 `#EXT-X-DISCONTINUITY`（时间戳跳变）时可能发生。装上 ffmpeg 后勾选「用 ffmpeg 修复时间戳」，或 CLI 加 `--remux`，产出 `output.fixed.ts`。分片都在，不用重新下载。

**Q：任务中断了，能接着下吗**
能。用同样的输出目录重跑同一个 URL，已存在的分片会自动跳过。

**Q：磁盘占用太大**
一个 3 小时的视频约 0.6 GB 分片 + 0.6 GB 成品。成品确认能播后，点「清理分片」删掉 `segments/`。

**Q：想更快下完**
调高倍速，例如 `--speed 8` 或 `--speed 0`（不限速）。注意倍速越高，请求越密集。

---

## 项目结构

```
src/
├── types.ts           # 类型与事件定义
├── control.ts         # 暂停 / 取消 / 时间轴平移
├── playlist.ts        # m3u8 解析
├── headers.ts         # 请求头 Profile
├── http.ts            # FetchHttpClient，实现 HttpClient 接口
├── scheduler.ts       # 绝对时间轴节拍 + 重试（核心）
├── store.ts           # 分片落盘 + state.json
├── merge.ts           # 二进制拼接
├── files.ts           # 任务目录扫描（文件管理页的数据源）
├── task.ts            # DownloadTask 编排 + 事件发射
├── cli.ts             # 命令行入口
└── server.ts          # GUI 后端（HTTP + SSE）
web/
├── index.html
├── app.js
└── style.css
deploy/
└── m3u8-downloader.service   # systemd 单元
start.cmd              # Windows 一键启动
```

约 1700 行 TypeScript + 原生前端，零运行时依赖。

---

## 开发

源码不需要编译，Node 直接执行。若想在编辑器里获得完整类型提示：

```bash
pnpm add -D typescript @types/node
pnpm exec tsc --noEmit
```

调试时建议用高倍速或 `--limit` 缩小规模，避免每次等几分钟：

```bash
node src/cli.ts "<url>" --limit 5 --speed 20 --out ./tmp
```

---

## 免责声明

> 使用本项目即表示你已阅读、理解并同意以下全部条款。若不同意，请立即停止使用并删除本项目。

### 一、用途限定

本项目仅用于下载**你有权访问的内容**，包括：

- 你本人已购买、已订阅或已获授权的内容；
- 你拥有著作权的内容；
- 版权方明确允许离线保存的内容。

### 二、责任归属

- 下载行为是否符合目标平台的服务条款，由**使用者自行判断**。
- 因使用本项目产生的任何法律纠纷、账号封禁、服务中断、数据丢失或其他损失，**作者不承担任何责任**。
- 请自行确认并遵守你所在国家或地区的著作权法律法规。

### 三、明确不提供的能力

本项目**不包含、不提供、也不协助**：

- 任何 DRM（Widevine / FairPlay / PlayReady）的破解或绕过；
- 付费墙、会员权限、试看限制的绕过；
- 加密密钥的非法获取或传播；
- 对目标站点的扫描、攻击或压力测试。

列表中出现 `#EXT-X-KEY` 时会**直接报错退出**——这是设计上的拒绝，不是功能缺失。

### 四、禁止行为

请勿将本项目用于：

- 批量抓取并**公开传播**他人作品；
- 商业性复制、转售或再分发；
- 规避平台的技术保护措施；
- 任何违反当地法律或平台规则的行为。

### 五、无担保

本项目按「现状」（AS IS）提供，不附带任何明示或暗示的担保，包括但不限于适销性、特定用途适用性与非侵权保证。作者不保证其可用性、准确性或不会中断。

### 六、数据与隐私

本项目**不收集、不上传、不分析**任何用户数据。所有请求由你的机器直接发往目标站点，作者无从得知你下载了什么。GUI 仅在 `127.0.0.1` 上监听，参数只存在你浏览器本地的 `localStorage` 中。

### 七、权利主张

如果你是权利人，认为本项目侵犯了你的合法权益，请通过仓库 Issue 联系，核实后我会移除相关内容。

---

## 许可证

[MIT](LICENSE)
