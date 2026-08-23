# Timeline Image API — 测试用例与结果报告（含调用参数与截图）

> 快照：2026-08-23 v9.22。截图位于 `timeline-image-dev/results/REPORT-ASSETS/`（已 pin 不会被 prune 清理）。
> 调用入口：页面内 `trace.timelineImage.renderTimelineImage(opts)`；外部经 postMessage（§6）。

## 1. 集成测试（9/9 通过）— 逐用例

### A2: pin 排序 + 堆叠布局 + 非纯色
```ts
// ui/src/test/timeline_image.test.ts（fixture: smartperfetto jank, A2 窗）
renderTimelineImage({
  trackUris: ['/thread_7303', '/cpu_freq_cpu0-3', '/sched_cpu0-3'],
  pinTracks: ['/thread_7303'],
  timeSpan: {start: 506734750000000n, end: 506736000000000n},
  widthPx: 1200, devicePixelRatio: 1,
})
```
- 期望：前两条为 RenderThread（state 18px + slice 132px）；各 band 颜色数 >10（非纯色）
- 实际：✅ 通过；截图 `timeline-image-dev/results/REPORT-ASSETS/integration-a2-pinned.png`
- 完整产物目录：[results/integration/](../results/integration/)（每跑一次一个时间戳 PNG）

### 字节确定性
```ts
const a = await renderTimelineImage(OPTS); const b = await renderTimelineImage(OPTS);
// 逐字节比较 a.blob / b.blob
```
- 期望：byte-identical；实际：✅（根因修复后 GPU/SwiftShader 双后端 20/20 全等，见 §5）

### A1: 窗口左缘
```ts
renderTimelineImage({trackUris: ['/sched_cpu0'], timeSpan: A1_WINDOW /*含最差帧左缘*/,
  widthPx: 1200, includeTrackShell: false, includeTimeAxis: false})
```
- 期望：左缘 5% 区域颜色数 >1；实际：✅

### G1: 默认输出 == UI 顺序（自动断言）
```ts
const r = await renderTimelineImage({widthPx: 1600, devicePixelRatio: 1});
const uiTitles = [...document.querySelectorAll('.pf-track__title')].map(e => e.textContent);
// 断言 r.trackBoxes 前 N 个 name 与 uiTitles 逐一相等
```
- 期望/实际：✅ `["CPU Scheduling","CPU 0 Scheduling",...] == UI DOM` 逐项一致

### C1: 装饰（名称列+时间轴）
```ts
const with = await renderTimelineImage(common);          // 默认 include* = true
const bare = await renderTimelineImage({...common, includeTrackShell: false, includeTimeAxis: false});
// 断言 with.height - bare.height === 22；名称列区(0..240px)与轴行(250..1200,0..22)像素数 >2
```
- 期望/实际：✅ 高度差 22px，两区域均有内容像素

### T1.27/T1.28: 按名定位 + 宽高比
```ts
renderTimelineImage({
  trackUris: ['/sched_cpu0'],
  trackNames: [{name: 'RenderThread', tid: 13585}],
  aspectRatio: 4/3, widthPx 不传（互斥）,
})
```
- 期望：names[1..2] = "RenderThread 13585"×2（state+slice）；`width === round(height*4/3)`
- 实际：✅

### T1.27: 未匹配告警
```ts
renderTimelineImage({trackUris: ['/sched_cpu0'], trackNames: [{name:'NoSuchThread', tid: 999999}], ...})
```
- 期望：warnings 含 `TRACK_MISSING` 且 sched_cpu0 照常渲染（trackCount=1）；实际：✅

## 2. 黄金场景（3/3 基线 MATCH，含像素 hash 硬断言）

### G-STD — 标准工作集
```ts
// tools/timeline-image/run-golden.mjs 注册表（参数冻结）
renderTimelineImage({
  trackUris: ['/cpu_freq_cpu0..3', '/sched_cpu0..3', '/thread_7303'],
  pinTracks: ['/thread_7303'],
  timeSpan: {start: '506734750000000', end: '506736000000000'},
  widthPx: 1800, devicePixelRatio: 1, perTrackTimeoutMs: 20000,
})
```
- 实际：1800×392、10 track、warnings=[]、~209ms API 耗时、BASELINE MATCH ✓
- **截图**：`timeline-image-dev/results/REPORT-ASSETS/G-STD-golden.png`（API 输出）｜`G-STD-ui-reference.png`（浏览器同屏参照）
- 基线：[baselines/G-STD.json](baselines/G-STD.json)

### G-DEFAULT — 零参数语义
```ts
renderTimelineImage({widthPx: 1800, devicePixelRatio: 1})  // 不传 trackUris/timeSpan
```
- 实际：1800×6579、**174 track**（=UI 默认全部可见行，含组标题行）、MATCH ✓
- 截图：run 目录 `timeline-image-dev/results/<时间戳>-golden-G-DEFAULT/golden.png`（高图不复制进资产目录）

### G-E1 — 用户亲写用例（example_android_trace.pftrace）
```ts
renderTimelineImage({
  trackUris: ['/cpu_freq_cpu0..8', '/sched_cpu0..8'],
  trackNames: [{name: 'RenderThread', tid: 4543}],
  pinTracks: ['/thread_75'],
  timeSpan: {start: '3428202643641', end: '3428410622726'},  // slice[95635]..slice[115701]
  aspectRatio: 4/3, devicePixelRatio: 1,
})
```
- 实际：**913×685（913/685=1.3330 精确 4:3）**、20 track（RenderThread state+slice 置顶 + 9 freq + 9 sched）、warnings=[]、MATCH ✓
- **截图**：`G-E1-golden.png`（API 输出）｜`G-E1-ui-reference.png`（浏览器参照）
- 基线：`baselines/G-E1.json`

## 3. 覆盖率扫描（T1.15）
- 命令：`node tools/timeline-image/scan-tracks.mjs` / `scan-tracks-deep.mjs`
- 实际：6 fixture 默认视图零空白、noWarmup=0；jank fixture 1999 叶子分批渲染零空白（低覆盖 287 条 = 稀疏数据源正常）
- 结果 JSON：`timeline-image-dev/results/2026-08-23-04-23-23-t1.15-scan/*.json`

## 4. 确定性（T1.14 收口）
- 命令：A/B 实验脚本（20 次连渲 × GPU/SwiftShader）
- 实际：修复后**双后端各 20/20 单一 hash**；差异定位图 `REPORT-ASSETS/determinism-variant-a.png` / `-b.png`（修复前两收敛态：A 有 slice 标签 B 无）
- 根因：maxRounds=3 截断；修复：上限 8（健康路径 2-3 轮提前退出）

## 5. postMessage 端到端（M2）
- 命令：`node tools/timeline-image/postmessage-demo.mjs`
- 调用链：宿主页 iframe → `PING`→`PONG` → `{perfetto:{buffer,keepApiOpen:true}}` + `{perfetto:{action:'renderTimelineImage', id:'demo-1', options:{trackNames:[{name:'RenderThread',tid:13585}], trackUris:['/cpu_freq_cpu0','/sched_cpu0'], timeSpan:{...A2}, widthPx:1200, devicePixelRatio:1}}}` → `{perfetto:{action:'renderTimelineImageResult', id, png:ArrayBuffer, result}}`
- 实际：~8s 端到端、warnings=[]、4 track
- **截图**：`REPORT-ASSETS/postmessage-host-page.png`（宿主页全貌：iframe 内 UI + 回传 PNG 预览）｜`postmessage-shot.png`（API 回传的 PNG 原图）

## 6. 全量官方套件（T1.29）
- 干净全量 31 spec：13 过（含本 API 9/9）、39 失败=100% 像素基线 diff（环境性豁免，证据：全局雪花 diff 形态/零功能错误/抽样复跑功能全通）、40 链式跳过
- 归因报告：`timeline-image-dev/results/2026-08-23T05-30-t1.29-full-regression/attribution.json` + 完整日志 `full-suite-clean.log`
- 典型 diff 样本：`out/ui/ui-test-results/test-load_and_tracks-load-trace-chromium/loaded-{expected,actual,diff}.png`

## 7. 性能实测
| 指标 | 实测值 | 场景 |
|---|---|---|
| renderTimelineImage API | 209ms（load 165/draw 22/encode 21） | G-STD 10 track |
| 端到端（浏览器+加载+渲染，native tp） | ~5s | 同上 |
| native tp 加载 14.9MB | 0.9s（WASM 4.3s，4.8x） | jank fixture |
| example 58MB 加载 | 2.6s（WASM 3.3s） | G-E1 |
