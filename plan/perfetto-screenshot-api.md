# Perfetto UI 程序化截图 API（Trace → Image）设计与实现方案

> 版本：v9-final（2026-08-23）。全文经多轮 review（逻辑、源码深度验证、实测、结构、计划质量）定稿；修订史见附录 C。
> 目标：为 perfetto UI 增加**原生的、可编程调用的截图 API**，外部程序通过参数（时间范围、目标线程/track、显示/隐藏的组件等）直接获取目标时间线区域的 PNG 图像，替代"Playwright 操控浏览器"这种脆弱的黑盒方案。
> 质量标准：按可合并进 `google/perfetto` 上游的官方开源贡献标准设计（架构分层、测试、文档、review 反模式规避全量对标）。

---

## 0. TL;DR

- **问题**：性能开发人员需要把 jank 时间段的 SF/RenderThread 等 track pin 到顶部并导出图像嵌入报告；现有 Playwright 外部操控方案脆弱、慢、无法精确控制渲染内容。
- **方案**：在 perfetto UI 源码内新增三层能力——Timeline 插件内的离屏渲染器（L1）、`trace.renderTimelineImage()` public API（L2）、postMessage/Command/MCP 三个调用入口（L3）。输出是全新合成的画布，页面组件（侧栏/底栏/弹窗）从不参与绘制，"隐藏"是设计保证。
- **可行性依据**：渲染层纯数值驱动（track 高度无 DOM 测量、绘制同步、TimeScale 纯函数）；数据量与像素数成正比而与 trace 大小无关（mipmap 分桶）。关键源码事实均经逐条核验（§1.3）。
- **交付**：3 个独立可合入的 PR（§7），首个 PR 完成即可在控制台一行出图。
- **成功指标**：替代 Playwright 流水线（单图耗时减半、零 DOM 依赖、与用户所见同像素）（§1.4）。
- **最大风险**：上游维护者接受度——图像导出无先例；缓解：先开 feature issue、PR 1 聚焦无 UI 影响的原语、提供 MCP 入口选项（§9）。
- **执行跟踪**：附录 D（任务表 + 五态状态机 + 失败留痕）；对外分享本文档时截至附录 C。

---

## 1. 背景与目标

### 1.1 问题与用户场景

性能开发人员在分析 jank 问题时，希望：加载一份 perfetto trace 后，把 SurfaceFlinger / RenderThread 等关键线程在故障时间段的 track **pin 到顶部**，设置合适的时间窗口，然后**导出为图片**嵌入性能报告 / bug 单 / CI 产物。目前的 Playwright 方案需要在浏览器外驱动整个 UI（模拟点击 pin、模拟缩放、整页截图再裁剪），脆弱、慢、无法精确控制渲染内容。

### 1.2 官方现状（基于 main@4b69bf97 的源码研究 + 社区调研）

| 能力 | 现状 | 位置（符号名，详见附录 A） |
|---|---|---|
| UI 截图/图像导出 | **不存在**（产品代码中唯一 `toDataURL` 在 VideoFrames 插件，用于视频帧缩略图） | `dev.perfetto.VideoFrames/video_frame_player.ts` |
| 外部控制时间范围 | 已支持：URL `visStart/visEnd`（纳秒，一次性）；postMessage `scrollToTimeRange`（运行时，秒） | `dev.perfetto.DeeplinkQuerystring`；`post_message_handler.ts` |
| pin tracks 到顶部 | 已支持：`Workspace.pinTrack(uri)`；startup command `dev.perfetto.PinTracksByRegex` | `public/workspace.ts`；`dev.perfetto.CoreCommands` |
| 隐藏侧栏 | URL `hideSidebar=true`、`mode=embedded` | `public/route_schema.ts` |
| iframe embedding | 完整支持：PING/PONG 握手、postMessage 传 trace buffer/appState/pluginArgs | `post_message_handler.ts`；`docs/visualization/embedding-the-ui.md` |
| 状态序列化 | viewport/pinnedTracks/notes/selection 均可序列化（permalink、localStorage） | `core/state_serialization.ts` |
| headless 截图 | 官方 CI 有 Playwright 像素 diff 基建，但**未产品化** | `ui/playwright.config.ts`、`perfetto_ui_test_helper.ts` |
| MCP 插件 | **已存在** `com.google.PerfettoMcp`（对外暴露受限 query API），是官方正在投入的自动化方向 | `com.google.PerfettoMcp/query.ts` |
| 社区需求 | [Issue #2266](https://github.com/google/perfetto/issues/2266)（rich embedding API，open）；官方立场：自动化分析走 trace_processor/SQL，UI 自动化走 deep-link + commands；**"trace→PNG" 无官方计划，属空白领域** | — |

### 1.3 关键架构事实（可行性依据，均经源码核验）

当前 UI 已完成 Mithril 迁移，渲染层是**纯数值驱动的 canvas 分层**：

1. **track 高度不依赖 DOM 测量**：`TrackView.getTrackHeight()` = track renderer 自报的 `getHeight()`，布局是纯算术。
2. **track 绘制接口是同步的**：`TrackView.drawCanvas()` 只消费 `(ctx, renderer, timescale, visibleWindow, size, verticalBounds)`；Renderer 抽象有 `Canvas2DRenderer`/`WebGLRenderer` 双后端。
3. **`TimeScale` 是纯函数**：时间 span + 像素 bounds 双向换算，可任意构造。
4. **重绘调度可绕过**：`RafScheduler` 只是调度器，drawCanvas 回调可脱离 rAF 直接调用。
5. **三个必须正面处理的约束**：
   - **数据加载由绘制路径驱动**：track 数据经 `render()` → `AsyncMemo.use()` 才发起查询，且 memo 键为 `{start, end, resolution}`（`buffered_bounds.ts` 的 3x 量化）。缓存与视口宽度耦合——截图宽度与 UI 视口不同时缓存不互通。
   - **resolution 与 bounds 由 renderer 内部派生**：`resolution = timeSpan / size.width` 在 `TrackView.drawCanvas` 的 `calculateResolution` 中算出、查询 bounds 由 `BufferedBounds`（3x padding）构造。关键事实：`TrackRenderContext.resolution` 是**既有必填字段**（`public/track.ts`）且数据查询已消费它——离屏路径自建 render context 即可注入任意 resolution，**无需接口变更**；mipmap 算子（slice/counter）对窗口左边界内置 back-off/carry-in，**精确 bounds 在数据正确性上安全**（§3.3.1）。
   - **UI 默认后端是 WebGL**：`VirtualOverlayCanvas` 优先创建 WebGL canvas，Canvas2D 是回退路径——离屏渲染若走 2D，输出与用户所见存在像素差异，且该路径缺乏日常使用检验。

**结论：离屏渲染可行，但设计必须内建"加载/绘制解耦"与"WebGL 读回一致性"两个机制（§3.3、§4）。**

### 1.4 目标、成功指标与 Non-goals

**成功指标（用户层，区别于 §6.4 工程验收）**：
1. **替代现有 Playwright 流水线**：单图端到端耗时 ≤ 现方案 1/2（现值待迁移时实测，冷启动含 trace 加载，热缓存差距更大）；达标路径遵循 top-down 优化闭环与杠杆清单（§5.4）；
2. **零 DOM 依赖**：出图脚本无任何选择器/点击/滚动模拟，UI 改版（含官方大版本）零适配成本——以"官方 UI 一次真实改版后本服务零修改仍出图"为终极验证；
3. **像素级精确**：与用户在 UI 中看到的时间线同后端同像素（WebGL 基线），报告中图像可直接用于 bug 单回溯（配 permalink 参数，PR 3 增值项）。

**Non-goals（防 scope creep，明确不做）**：远程（跨机）渲染服务；trace 解析结果持久化（走 TP export，§8.2）；WebGL→2D 之外的 GL 高级合成；视频/动图导出；非时间线区域（details panel/查询表）的离屏渲染；自动化 jank 分析（smartperfetto 类系统的职责，本 API 只供图）；修改官方 postMessage 信任模型。

---

## 2. 方案选型（为什么是这个方向）

| 方案 | 精确性 | 稳定性 | 可合并上游 | 依赖 |
|---|---|---|---|---|
| **A. 本方案：原生截图 API** | 精确控制时间窗/track/组件 | 不依赖 DOM 结构与交互模拟 | ✅ 官方分层规范内 | 无 |
| B. Playwright 操控 UI（现状） | 受选择器/布局脆弱性制约 | UI 改版即坏 | ❌ 不可上游 | 每次跑完整浏览器交互 |
| C. 纯 SQL/trace_processor 出数据 | 无图（不是同类产物） | 高 | — | 无法可视化 |
| D. 官方 CI 式整页截图 | 只能截"当前视口全页" | 中 | ❌ 测试基建非产品 | Playwright |

方案 B 在过渡期保留为兜底调用方（它反向受益：可用新 API 一次 postMessage 完成截图，删掉所有模拟操作）；正式替代以 §1.4 指标达成为准。已否决的历史决策（L1 曾放 core/、queryBounds padding 论断、capabilities 声明、base64 响应、URL 自动回传、Bigtrace 等）见附录 B ADR。

---

## 3. 总体设计

### 3.1 设计原则（对标上游 review 标准）

依据 `docs/AGENTS-ui.md` 与 `docs/ui-review-antipatterns.md`：

- **分层正确**：public API 面放 `ui/src/public/`（薄接口 + 完整 doc 注释），渲染原语与 Timeline 画布代码同插件（§3.2），面向用户的入口按官方惯例做成插件/既有协议扩展。**不在插件里伸手进 core 内部，也不让 core 依赖 core_plugins**。
- **不过度设计**：复用 `TimeScale`、`Renderer`、`CanvasColors`、`Workspace`、`TrackView` 的一切既有能力，只新增"把既有渲染组织到一张离屏 canvas 上"这一层。
- **状态单一来源**：截图输入是一次性调用参数（snapshot 语义），不引入新的全局状态。
- **确定性优先**：输出图像是可 diff 的产物，一切影响像素的全局状态（时间戳格式、selection、hover、note 显示）都必须显式参数化或固定默认值。
- **失败可见**：数据未就绪/track 不存在/预算超限时返回明确 warning 或错误，绝不静默返回空白图。
- **增量可 review**：拆成 3 个独立 PR，每个可独立合入、独立回滚；接口变更在 PR 1 中显式声明，不伪装成"纯内部改动"。

### 3.2 分层与落位（照 minimap 注册反转模式）

**命名**：public 层 API 定名 `renderTimelineImage`（`ui/src/public/timeline_image.ts`），避免与既有 `dev.perfetto.Screenshots` 插件（Android 截图 track）及 `screenshots_track.test.ts` 混淆——"screenshot" 在 perfetto 语境已有所指。

**落位**：`TrackView`/`TrackTreeView` 位于 `core_plugins/dev.perfetto.Timeline/`，而 `core/` 对 `core_plugins/` 的依赖在全源码树**零先例**且违反分层反模式（"具体内容推送到插件中"）。因此离屏渲染器不放 `core/`，复刻 minimap 的既有模式：

```
┌────────────────────────────────────────────────────────────────────┐
│ L3 入口层（外部程序如何调用）                                        │
│  a) postMessage 协议扩展（主入口：本地脚本 / iframe 嵌入）            │
│  b) Trace command（人肉 + startupCommands 宏系统）                   │
│  c) MCP tool（PR 3 候选，对齐官方 com.google.PerfettoMcp 方向）      │
│  d) URL 深链接（降级为"生成下载链接 + 通知"，不承担取图闭环）         │
├────────────────────────────────────────────────────────────────────┤
│ L2 public API 层                                                    │
│  public/timeline_image.ts：TimelineImageManager 接口（纯声明）      │
│  trace.renderTimelineImage(options): Promise<TimelineImageResult>  │
├────────────────────────────────────────────────────────────────────┤
│ core/timeline_image_manager.ts：注册制管理器（只 import base+public）│
│   ↑ 注册                                                             │
│ core_plugins/dev.perfetto.Timeline/offscreen_timeline_renderer.ts： │
│   离屏渲染器本体（两段式 warm-up → barrier → render；               │
│   与 TrackView/绘制序列同插件，复用无分层问题）                      │
└────────────────────────────────────────────────────────────────────┘
```

对照先例：`public/minimap.ts` 定义 `MinimapManager` → `core/minimap_manager.ts` 实现（仅 import base/public）→ Timeline 插件的 `minimap.ts` 注册内容提供者。TimelineImageManager 同构：Timeline 插件加载时把离屏绘制函数注册进管理器，`TraceImpl` 上的 `renderTimelineImage()` 委托调用；Timeline 插件缺席时返回明确错误（`TIMELINE_UNAVAILABLE`）而非静默失败。

### 3.3 L1 — 离屏渲染器（Timeline 插件内）

新文件 `ui/src/core_plugins/dev.perfetto.Timeline/offscreen_timeline_renderer.ts`。

#### 3.3.1 经源码核验的三个基础事实

1. **dpr 解耦零接口变更**：`TrackRenderContext.resolution` 是既有必填字段（`public/track.ts`），由 `TrackView.drawCanvas` 的 `calculateResolution` 填充；而 track 数据查询（如 `slice_track` 的 `useData`）**已消费 `ctx.resolution`**。离屏渲染器自建 render context：`size` 按 2x 画布、`resolution` 显式填 1x 值——数据查询自动按 1x 分桶，绘制几何按 2x，解耦天然成立。
2. **精确 bounds 数据正确性安全**：`src/trace_processor/plugins/slice_mipmap_operator/slice_mipmap_operator.cc` 对窗口左边界内置回退一步（"If the slice before this window overlaps with the current window, move the iterator back one"），贯穿窗口的长 slice 会纳入首桶聚合；incomplete slices 的 SQL 本身是重叠语义（`ts < end AND next_ts > start`）；counter 算子有显式 carry-in（`counter_mipmap_operator.cc`）。因此 `queryBounds` 只剩性能语义。
3. **AsyncMemo 的取消不外泄**：`use()` 同步返回快照（不返回 Promise）；TASK_CANCELLED 在 memo 内部处理（不缓存、下次同 key `use()` 自动重调度），**永远不会抛给调用者**。等待数据就绪的实现路径：给 AsyncMemo 暴露 pending 完成的 Promise（小改，首选），或轮询 `use()` 快照（同 key 不重复调度，轮询安全）。

#### 3.3.2 接口增量（收敛为两项，均为可选）

```ts
// TrackRenderContext 新增可选字段（缺省 = 现状 3x BufferedBounds，UI 主路径零影响）：
{
  ...
  // 查询 bounds 覆盖。性能用途（绕开 renderer 内部 3x skirt，冷查询数据量
  // 降为 1/3）；正确性不需要（mipmap 算子内置边界处理，见 3.3.1 事实 2）。
  // 可作为 renderer 逐个采用的 opt-in；未采用的 renderer 走 3x 现状，
  // 只是查询量偏大，输出不受影响。
  queryBounds?: TimeSpan;
}
// TrackRenderer 新增可选方法（语义级，不暴露私有 key 类型）：
//   覆盖该 renderer 全部 memo 槽，支持定点迭代（见 3.3.3 阶段 C）。
//   未实现 = "立即就绪"（回退现状：绘制路径自行触发加载，可能截到棋盘格，
//   截图路径对此类 renderer 以 whenDataReady 轮询 + warning 兜底）。
whenDataReady?(renderCtx): Promise<void>;
```

混合采用无正确性风险：`queryBounds` 未被 renderer 采用只是查询量差异；`whenDataReady` 未实现有明确回退语义。

#### 3.3.3 两段式渲染（加载与绘制解耦）

```
阶段 A  warm-up：以最终渲染上下文（timeSpan、显式 resolution/queryBounds、
        每 track 最终尺寸）对每个目标 track 调用 whenDataReady(ctx)，
        触发 memo 加载并等待落定。带 per-track 超时，超时者软退出
        （绘制旧帧或棋盘格 + warning）。memo 的取消重试由 AsyncMemo
        内部自动完成（TASK_CANCELLED 不外泄），无需 API 层重试逻辑。
阶段 B  barrier → 同任务绘制：最后一个 promise 落定后，正式绘制必须在
        **同一同步任务**内完成（中间无 await/rAF）——否则 UI 重绘可在
        间隙逐出单条目 memo，导致当帧重查、棋盘格入图。若同步绘制时
        检测到缓存被逐出（key 已变），回退阶段 A 重等（计入同一预算）。
阶段 C  定点迭代：部分 track 的查询是数据依赖的二阶链（首轮数据到达后
        render 才发下一批查询）。首帧绘制后检测新 pending 的加载，若有
        则再等再画，至多 N 轮（N=2~3）或增量预算耗尽；仍不完整的 track
        按软退出处理。
```

单飞互斥（§5.3 第 2 条）只保护"截图 vs 截图"；同任务绘制与逐出回退处理"UI 重绘 vs 截图"。headless 渲染服务无 UI 交互天然免疫；`matchUi` 交互场景（§3.3.5）是竞争高发区，规则必须内建。

#### 3.3.4 渲染后端（默认 WebGL，与 UI 主路径同后端）

保证截图与用户所见像素一致、像素 diff 基线唯一。WebGL 特有的两个硬性要求：

1. **读回一致性**：WebGL 默认在帧合成后清空 drawingBuffer，帧外 `toBlob()`/`drawImage()` 会得到**全黑图像**。必须任选其一：创建 GL context 时 `preserveDrawingBuffer: true`（简单，性能影响可接受——离屏 context 不参与 UI 每帧合成）；或在 draw 后的同一同步块内完成 `drawImage` 读回。"非纯色图像"检查纳入验收断言（§6.4）——黑屏/空白是尺寸合法的失效模式。
2. **context 复用**：浏览器每页 GL context 数量有上限（约 16，超限 context lost）。离屏 GL context **进程内单例**：所有截图与分片共享一个离屏 GL canvas，逐片 `drawImage` 到 2D canvas 后 `clear()`；长驻渲染服务定期 `loseContext()` 重建防状态累积（§8.5）。

Canvas2D 路径保留为 jsdom 单测与 WebGL 不可用环境的降级，其与 GL 的输出差异在文档中声明、不作为基线。

#### 3.3.5 分辨率与缓存策略（matchUi 语义的权威定义）

memo 键含 `resolution`，截图宽度与 UI 视口宽不同时**默认不命中 UI 已有缓存**。策略显式化为参数：

- `resolutionMode: 'exact'`（默认）：按 `widthPx` 精确计算 resolution，输出最优；UI 缓存复用是**机会性的**（仅当量化桶恰好一致时命中）。
- `resolutionMode: 'matchUi'`：将 resolution 对齐到当前 UI 视口的量化桶，可复用用户已看区域的数据（零查询）。**不变式：`timeSpan` 恒定不可变，只有输出宽度可变**（若固定 widthPx 则渲染出的时间范围会静默偏离请求值——禁止）；结果如实报告实际 px。该模式主要服务"人正在看 UI + 顺手截图"的交互场景；headless 渲染服务（视口从未加载过数据）下无意义。
- **性能承诺**：确定性保证只有一条——同参数（timeSpan+trackUris+resolutionMode+widthPx）**重复截图**命中 memo；"用户看过即命中"仅在 `matchUi` 下成立。

#### 3.3.6 参数与实现要点

```ts
export interface OffscreenRenderOptions {
  // 时间范围；默认当前 visibleWindow。允许超出 trace 边界，超出部分按
  // trace 边界 clamp 并记 CLIPPED warning（而非报错——半开窗口常见）。
  timeSpan?: HighPrecisionTimeSpan;
  // track 渲染集合与顺序：trackUris 数组序即渲染序（自上而下）。
  // 缺省 = 当前 workspace 全部可见 track（按 workspace 序）。
  trackUris?: readonly string[];
  // resolution 策略（见 3.3.5），默认 'exact'
  resolutionMode?: 'exact' | 'matchUi';
  widthPx?: number;              // 默认 1920
  trackHeightScale?: number;     // 默认 1.0
  // 组件包含项（默认如下，全部可关）
  includeTimeAxis?: boolean;     // true
  includeTrackShell?: boolean;   // true（shell 宽度复用 TRACK_SHELL_WIDTH
                                 // 常量，见 §4 难点 D5）
  includeGrid?: boolean;         // true
  // 确定性开关（默认关闭一切会话态内容——截图是可 diff 产物）
  includeSelection?: boolean;    // false
  includeNotes?: boolean;        // false
  // 时间戳格式：默认固定为 trace 开始相对秒（不读用户设置，保证确定性）
  timestampFormat?: TimestampFormat;
  devicePixelRatio?: number;     // 默认 2
  background?: string;           // 默认取 CSS 常量（暗色）
}

export interface OffscreenRenderResult {
  canvas: HTMLCanvasElement;     // WebGL 路径最终产出 2D canvas（含合成拷贝）
  width: number; height: number; // 实际像素（matchUi/降级后可能 ≠ 请求值）
}
```

1. 画布尺寸预算联合求解（§5.3 第 4 条）。
2. 手动构造 `TimeScale`（timeSpan → 像素 bounds），构造方式与 `TrackTreeView.drawCanvas()` 一致。
3. 逐 track 调 `TrackView.drawCanvas`（public 签名，可直接复用）纵向堆叠；pinned 视觉语义见 §3.4 `pinTracks`。
4. **提取而非复用 `TrackTreeView.drawCanvas`**：它是 private 且绑定 Mithril/VirtualOverlayCanvas 生命周期（`raf.addCanvasRedrawCallback`）。将绘制序列（网格 → track → flow events → notes → overlay）提取为以 `(timeScale, widthPx, trackViews, format)` 为入参的纯函数，UI 主路径与离屏路径共用（无行为变化，上游加分项）；时间轴刻度密度算法同步接受任意宽度。
5. 时间轴/网格/track shell 复用 `time_axis_panel` 等既有绘制逻辑；字体确定性：绘制前 `await document.fonts.ready`。

### 3.4 L2 — public API：`trace.renderTimelineImage()`

新文件 `ui/src/public/timeline_image.ts`：定义 `TimelineImageManager` 接口与选项/结果类型（纯声明，对齐 `public/minimap.ts` 的粒度）；实现于 `core/timeline_image_manager.ts`（注册制，只 import base+public），由 Timeline 插件注册绘制函数（§3.2）。`renderTimelineImage()` 挂到 `Trace` 接口（`TraceImpl` 委托实现——`scrollTo`/minimap 已有同样先例；`createFakeTraceImpl` 复用真实 TraceImpl，测试 fake 无需修补）：

```ts
export interface TimelineImageOptions extends OffscreenRenderOptions {
  // 置顶排序：pinTracks 中的 uri 提到图像最上方（保持 trackUris 内相对序）。
  // 语义：pin 的 track 必须同时出现在 trackUris（或缺省集合）中才渲染，
  // 仅出现在 pinTracks 而不在渲染集合中的 uri 记 TRACK_NOT_RENDERED warning。
  pinTracks?: readonly string[];
  format?: 'image/png' | 'image/jpeg';
  budget?: TimelineImageBudget;           // 见 §5.3
  stitch?: boolean;                       // 超高分片，见 §5.3 第 5 条
  onProgress?(progress: TimelineImageProgress): void;
}

export interface TimelineImageResult {
  blob: Blob;
  width: number; height: number;       // 实际输出（可能因 matchUi/降级改变）
  completedTracks: readonly string[];
  warnings: readonly TimelineImageWarning[];  // TIMEOUT | DOWNSCALED | CLIPPED |
                                           // TRACK_MISSING | TRACK_NOT_RENDERED |
                                           // TIMELINE_UNAVAILABLE | BUSY | ...
  // 渲染元数据：功能断言（§6.2）与调用方图像后处理（叠加标注/热点图）的依据
  metadata?: {
    // 每个已渲染 track 的名称与包围盒（相对输出图像，CSS px × dpr）
    trackBoxes: ReadonlyArray<{uri: string; name: string; y: number; height: number}>;
    // 实际绘制的组件清单（'timeAxis' | 'trackShell' | 'grid' | 'selection' | 'notes'）
    components: readonly string[];
    // track shell 中绘制的文本（track 名称等，按出现序）——shell 文本由
    // fillText 绘制、无 DOM 可查，这是文本正确性的唯一可编程断言途径
    drawnTexts: readonly string[];
  };
  perf: {loadMs: number; drawMs: number; encodeMs: number;
         cacheHits: number; queries: number; elapsedMs: number};
}

renderTimelineImage(opts?: Partial<TimelineImageOptions>): Promise<TimelineImageResult>;
```

**语义规范**：
- **snapshot**：读取调用时刻的 workspace/track 状态渲染，不改变用户 UI 状态（`pinTracks` 只影响截图内排序，不动真实 workspace）。
- **前置条件**：`renderTimelineImage` 是 `Trace` 实例方法，天然只在 trace 加载完成后可用；trace 未就绪时 L3 入口的排队语义见 §3.5(a)。
- **错误**（reject）：参数非法（widthPx≤0、trackUris 全部不存在）、trace 引擎已 dispose；其余异常情况一律走 `warnings` + 尽力输出（partial）。

### 3.5 L3 — 调用入口

**(a) postMessage 协议扩展（主入口）**——`post_message_handler.ts` 新增消息：

```jsonc
// 请求
{ "perfetto": { "renderTimelineImage": {
    "timeStart": 1234567000, "timeEnd": 2345678000,   // 纳秒，与 visStart/visEnd 一致
    "trackUris": ["..."], "pinTracks": ["..."],
    "widthPx": 2400, "includeTrackShell": true,
    "requestId": "abc"
}}}
// 进度（可选，多次；per-track 粒度节流——每 track 至多一条，避免 50 track 刷屏）
{ "perfetto": { "renderTimelineImageProgress": { "requestId": "abc", "completed": 3, "total": 8 } } }
// 响应（回发给请求方 source window）
{ "perfetto": { "renderTimelineImageResult": {
    "requestId": "abc", "width": 2400, "height": 800,
    "warnings": [...],
    "blob": Blob } } }   // 结构化克隆原生支持 Blob（跨 origin 亦然），
                         // 体积与 CPU 均优于 base64（无 +33% 膨胀）；
                         // "dataUrl" 仅作老宿主兼容选项，不使用分块协议
```

协议细则：
- **trace 未就绪时到达的请求：挂起而非照抄既有重试**。既有 `scrollToTimeRange` 的"排队"实为 200ms×20 次重试后**放弃**（约 4s 上限）——GB 级 trace 加载几分钟必超时丢请求。截图消息必须真正挂到 trace 就绪信号（`AppImpl` 的 activeTrace 就绪 promise）上无限期排队，配可选 `requestTimeoutMs`；**队列深度上限 32**，超限对新请求回 `BUSY` 拒绝；**trace 加载失败时清空队列并对每个 requestId 回错误响应**（防坏 trace 导致无限堆积）；同时注意 handler 的两个前置条件：`document.readyState !== 'complete'` 时消息直接丢弃（服务方应在 PONG 后再发），非 `keepApiOpen` 的 trace 上传消息会移除 message listener（截图请求场景要求 `keepApiOpen: true`）。
- **插入点**：`postMessageHandler` 是 if/return 顺序链，照 `PostedScrollToRangeWrapped` 的"类型守卫 + 提前 return"模式在 scrollTo 分支后插入；未被识别的消息落入 "Unknown postMessage() event" 警告并丢弃——消息名拼错时是静默失败，协议文档需强调。
- **信任模型与部署约束**：复用 `isTrustedOrigin()`（localhost 永远信任；非信任 origin 弹确认框）——渲染服务必须与 UI 同机（localhost）或宿主经授权，详见 §8.1。

**(b) Command**——`dev.perfetto.CoreCommands`（或新插件）注册：`dev.perfetto.RenderScreenshot`（当前视口全 track）、`dev.perfetto.RenderScreenshotOfSelection`（当前选区）。人肉场景直接用，同时天然被 startupCommands 宏系统支持。

**(c) MCP tool（PR 3 候选）**：将 `renderTimelineImage` 暴露为 `com.google.PerfettoMcp` 的一个 tool，AI agent/自动化工具可经标准 MCP 协议调用（MCP 协议原生支持 image content block）。官方已在该方向投入，截图作为其图像输出能力是自然延伸，**可能比扩展 postMessage 更易获得维护者认可**。待确认项：`PerfettoMcp` 的 server 架构（页面内 localhost socket 还是独立进程）决定外部进程能否直达该 tool——PR 1 落地后凭效果与维护者讨论并核实。

**(d) URL 深链接（降级语义）**：`?renderTimelineImage=1` 不承担"自动回传取图"（顶层窗口无回传目标、浏览器拦截无手势下载、headless 无人点击——取图闭环不成立）。降级语义：渲染完成后在页面内**生成下载链接 + postMessage 通知**（iframe 场景）；真正的自动化取图一律走 (a)。首版可完全砍掉，留作 PR 3 的便利性增强。

### 3.6 典型调用示例（覆盖用户原始场景）

```js
// 性能平台 jank 分析服务（headless Chrome + 本地 UI）
// 1. PING/PONG 握手后 postMessage 加载 trace buffer（既有协议，或经 §8.2 的 native TP 路径）
// 2. 按 utid/track name 查询目标 track uri（startup command RunQuery / MCP query）
// 3. 一步截图：
iframe.contentWindow.postMessage({perfetto: {renderTimelineImage: {
  timeStart: jankStartNs, timeEnd: jankEndNs,
  pinTracks: [sfTrackUri, appTrackUri, rtTrackUri],   // 置顶排序
  trackUris: [...pinTracks, binderUri, vsyncUid],     // 渲染集合与顺序
  widthPx: 2400,
}}}, '*');
// 4. 收到 renderTimelineImageResult，blob 存盘/入报告
```

无需 pin 点击、无需模拟缩放、无需 DOM 裁剪；输出只含时间轴 + 指定 track，天然适合嵌入报告。

---

## 4. 关键技术难点与对策

| # | 难点 | 对策 |
|---|---|---|
| D1 | **数据异步 + bounds/就绪信号由 renderer 内部派生** | 接口增量收敛为两项可选成员：`queryBounds`（性能用途，绕开 3x skirt）+ `whenDataReady(ctx)`（覆盖全部 memo 槽、定点迭代）；dpr 解耦零接口变更（`ctx.resolution` 已存在且数据路径已消费，见 §3.3.1 事实 1）。`whenDataReady` 未实现的 renderer 回退轮询 + warning，无正确性差异 |
| D2 | **接口变更的 review 阻力** | 变更全部为可选字段/方法，UI 主路径零行为变化，PR 1 显式声明并同步插件文档；备选：离屏渲染器内部 instanceof 白名单访问已知 renderer 的数据槽（丑但零接口变更），issue 讨论二选一 |
| D3 | **WebGL 是 UI 默认后端，且有读回/上下文两坑** | 离屏默认同后端（像素一致、基线唯一）；`preserveDrawingBuffer: true`（或 draw 后同步块内读回）防黑图；GL context 进程内单例 + 分片共享 + 定期 `loseContext()`。见 §3.3.4 |
| D4 | **缓存键含 resolution，截图与视口宽度解耦** | `resolutionMode: 'exact' \| 'matchUi'` 显式策略（matchUi 不变式：timeSpan 恒定、只有输出宽度可变，见 §3.3.5）；性能承诺修正为"同参数重复截图必命中" |
| D5 | **任意宽度下的组件自适应**：时间轴刻度密度、track shell 宽度占比 | 刻度算法参数化（接受任意 widthPx）；shell 宽度固定 `TRACK_SHELL_WIDTH` 常量（与 UI 一致，不随截图宽度缩放——保证与用户所见同构） |
| D6 | **track uri 的可发现性** | (1) `RunQuery` / MCP query；(2) 便捷参数 `trackNamePatterns`（复用 `PinTracksByRegex` 匹配逻辑），PR 3。**正则来自外部消息：加长度/复杂度上限与匹配超时防护（ReDoS 面，虽仅信任 origin 可达）** |
| D7 | **确定性渲染**（CI diff） | `includeSelection/includeNotes` 默认 false；`timestampFormat` 固定默认、不读用户设置；`document.fonts.ready` 预热；不依赖时钟/hover；**验证时间轴 label 是否经 `Intl`（locale 影响数字分组，跨机 diff 漂移）——若是，离屏路径强制 root locale** |
| D8 | **超大输出** | 画布尺寸联合求解上限 + 分片，见 §5.3 |
| D9 | **jsdom 无 canvas** | 测试分层（§6.1）：纯逻辑 jsdom 单测；渲染路径只走 Playwright 集成测试（真实浏览器） |
| D10 | **安全** | postMessage 响应只回发 source window；信任模型与部署约束统一见 §8.1 |

---

## 5. 性能与资源设计

### 5.1 性能模型（三个决定性源码事实）

1. **数据量与像素数成正比，与 trace 大小无关**：slice/counter track 走 mipmap 虚拟表按 `resolution`（ns/px）分桶聚合（counter 每 0.5px 取 min/max 桶）。同一时间窗口下，100MB 与 5GB 的 trace 单 track 拉回的行数量级相同——这是方案的根本保障。
2. **查询在单 worker 上串行执行且 SQL 不可取消**：每 engine 一个 Worker，查询线性排队；`AsyncMemo` 软取消只在结果迭代阶段生效，已入队的 SQL 只能跑完。
3. **屏外 track 从不加载数据**：时间线虚拟化，track 只有与视口重叠才触发查询——截图 N 条 track 时在默认 `exact` 模式下几乎全部冷缓存（含 UI 已看过的区域，见 D4）。

成本公式：**截图耗时 ≈ Σ(逐 track 的一次 mipmap 查询，串行主导) + 合成绘制(ms 级) + PNG 编码(由 width×height 决定)**。mipmap 算子内置边界 back-off/carry-in，显式 `queryBounds`（精确 timeSpan）在正确性上安全且把冷查询数据量从 3x skirt 压回 1x（§3.3.1 事实 2）。风险维度不是"trace 多大"，而是 `track 数量 × 截图宽度 × mipmap 层级深度`（renderer 未采用 `queryBounds` 时再乘 ~3）。

### 5.2 风险清单

| # | 风险 | 量级 | 后果 |
|---|---|---|---|
| R1 | 串行查询风暴（几十~上百 track 全量截图） | 50 track 可达 5–25s | 期间 UI 其他查询全被堵死 |
| R2 | 不可取消的队列阻塞（截图中继续操作 / 并发多张截图） | SQL 无法中止 | UI 冻结观感、请求叠加放大 R1 |
| R3 | 超宽截图放大查询与内存 | 10000×2000 位图即 80MB；Safari canvas 有边长/总面积上限 | 查询变慢、内存尖峰、直接失败 |
| R4 | 数据就绪等待超时/饥饿（深缩放、冷缓存、R1 排队） | — | 截到棋盘格或无限挂起 |
| R5 | 主线程长任务（大图合成 + 编码） | 100–500ms 同步 | 掉帧（一次性，可缓解） |
| R6 | 冷启动 mipmap 建表 | 首截图偏慢 | 非 API 新增（UI 正常路径已存在） |
| R7 | GB 级 trace 加载本身 | 分钟级 | 非 API 新增；截图等 trace 加载完成（`waitForPerfettoIdle` 语义），不抢跑；加载侧优化见 §8.2 |

明确**不是**风险：固定窗口下单 track 查询量（mipmap 保护）、绘制本身（O(pixels)）、原始 slice 数据（已在 trace_processor 内，截图不额外加载）。

### 5.3 预算、调度与输出控制

**预算驱动（budgeted rendering）**——超预算降级并如实报告，绝不静默挂起或 OOM：

```ts
interface TimelineImageBudget {
  timeoutMs?: number;           // 总预算，默认 30_000；超时按策略降级
  perTrackTimeoutMs?: number;   // 单 track 查询预算，默认 5_000
  onBudgetExceeded?: 'fail' | 'partial' | 'downscale';
}
```

1. **dpr 与数据分辨率解耦**：默认按 1x 分辨率拉数据、2x 画布绘制——查询桶数减半，视觉差异 ≤ 半个 CSS 像素（可被 `resolutionScale` 覆盖）。实现零接口变更（§3.3.1 事实 1）。查询 bounds 默认传显式 `queryBounds`（精确 timeSpan，压 3x skirt 至 1x，见 §5.1；正确性由算子内置边界处理保证）。
2. **与 UI 协作的查询调度**：逐 track 顺序预加载（worker 本就串行，并发只堆队列饿死 UI hover/selection）；同一时刻仅允许一个进行中的截图任务（并发请求排队或返回 `BUSY` warning）。`matchUi` 模式下 `start/end` 按 `BufferedBounds` 同款 3x 量化取整以命中 UI 缓存。
3. **软退出**：`perTrackTimeoutMs` 到点不再等该 track（查询最终自完成并留缓存，下次免费），标记 warning，绘制旧帧或棋盘格 + 注记，不阻塞整体。
4. **画布与内存上限（联合求解）**：约束为单一联合条件——`width ≤ 16384 ∧ height ≤ 16384 ∧ width×height ≤ 32M px（约 128MB RGBA）`；超限时按声明优先级缩：先降 dpr，再等比 `downscale`（warning 报告实际分辨率），`fail` 则直接报错。
5. **分片（tiling）**：track 多/输出超高时按 track 边界纵向分片（不切 track 内部），每片独立走 两段式渲染 + 编码 并独立 per-track 预算；**总 `timeoutMs` 为全局时钟**，各片只受剩余时间约束（不按片均分）。分片共享进程内单例 GL context（逐片 `drawImage` 后 `clear()`）与 AsyncMemo 缓存，第二片起同 track 零重查。是 R1 的结构性解法。
6. **编码**：`convertToBlob()`/`toBlob`（异步，不阻塞主线程绘制）；WebGL canvas 经 `drawImage` 合成到 2D 后编码。
7. **缓存承诺**：确定性保证 = 同参数重复截图全命中 memo（§3.3.5）；`matchUi` 模式可额外复用 UI 已加载数据；`exact` 模式对 UI 缓存的命中是机会性的。
8. **可观测性（双轨）**：宏观 = `TimelineImageResult.perf` 阶段耗时 + `cacheHits/queries`（面向调用方/CI）；微观 = metatrace 打点（面向开发定位，事件名约定与开关清单见 §6.5）。进行中任务经既有 taskTracker 显示；`onProgress` 回调（postMessage 入口转发为进度消息）。

### 5.4 性能优化方法论与杠杆清单（top-down）

性能目标分两层：**对比目标**（§1.4，单图 ≤ 现方案 1/2）与**绝对基准**（§6.4，冷 ≤5s/热 ≤1s）。达标路径遵循 top-down：先测全链路、按阶段归因、只攻大头、单变量改动、复测确认——测量基础即 §5.3 第 8 条/§6.5 的双轨观测（`result.perf` 三段 + metatrace/queryLog），不凭感觉优化。

**优化闭环**：

```
① 全链路基线：A2 用例跑 perf 三段 + 导出 metatrace（§6.5），产物存 out/test-runs/（D.4）
② 归因排序：按阶段占比找大头——trace 加载 / loadMs（查询）/ drawMs（绘制）/ encodeMs（编码）；
   查询段细分靠 queryLog 逐条 SQL 耗时
③ 攻大头：从下方杠杆表选对应项，单变量改动（一次只动一项）
④ 复测：同参数重跑 A2，软阈值趋势确认收益；无收益即回退并记 ADR（附录 B）
⑤ 循环至 §6.4 基准与 §1.4 目标达成；§8.5 看护数据持续反哺新一轮循环
前提：功能正确先行（M1/M2 完成）——过早优化违反"失败可见"原则，且无基线可对比
```

**优化杠杆清单**（按管线阶段分组；标注 by-design = 设计已含，无需额外开发）：

| 阶段 | 杠杆 | 预期收益 | 成本/风险 |
|---|---|---|---|
| trace 加载 | native TP `--httpd` 零传输（§8.2） | 大（GB 级分钟→秒） | 部署复杂度（by-plan） |
| trace 加载 | `export perfetto` 预解析（§8.2） | 大（跳过 ingestion+sorting） | 流水线前置步骤 |
| trace 加载 | `ingestFtraceInRawTable: false`（§8.2） | 中（显著降内存/解析） | raw 表不可用（截图不需要） |
| trace 加载 | 长驻服务摊薄（load once → N 张） | 大（边际成本趋零） | 服务生命周期管理 |
| loadMs 查询 | 只查指定 track（`trackUris` + 虚拟化） | **by-design**（与全量截图成倍差） | — |
| loadMs 查询 | `queryBounds` 精确 bounds（3x→1x） | **by-design** | — |
| loadMs 查询 | dpr 解耦（1x 数据 2x 画布） | **by-design**（查询桶数减半） | — |
| loadMs 查询 | mipmap 表预建：trace 加载完成后空闲期预热建表（消除首截图 R6 冷启动） | 中 | 空闲期判定 |
| loadMs 查询 | 慢查询治理：queryLog/metatrace 定位 → SQL/算子级修复（与上游协作） | 按发现 | 涉及 TP C++ |
| loadMs 查询 | `matchUi` 复用 UI 已加载数据（交互场景） | 场景性 | §3.3.5 语义限制 |
| drawMs 绘制 | **渲染服务真机 GPU**：headless Chrome `--use-angle=metal`（macOS）/headless new 模式启用 GPU，替代软件渲染 | 中 | ⚠ 输出像素与 CI 基线（llvmpipe）不再逐像素一致——报告场景可接受，CI 基线仍用 llvmpipe 保确定性 |
| drawMs 绘制 | 分片并行（多 canvas/多页面实例） | 中 | 复杂度 |
| encodeMs 编码 | OffscreenCanvas 移入 Worker 编码（与下一张绘制重叠） | 小–中 | 兼容性 |
| encodeMs 编码 | `format: 'image/jpeg'`（可接受有损时） | 小 | 质量 |
| 服务级吞吐 | 多 TP 实例 × 多页面并行（§8.2/§8.3） | 吞吐线性扩展 | 资源 |
| 服务级吞吐 | 业务已知 jank 窗口批量预热（常见窗口提前渲染进缓存） | 场景性 | 业务耦合 |

---

## 6. 测试与验收

### 6.1 测试分层、fixture 与真实参数集

**分层（对应 D9）**：纯逻辑（布局/预算/TimeScale/参数校验/warning 语义）走 vitest/jsdom 单测（mock memo/renderer）；渲染路径只走 Playwright 集成测试（真实浏览器 + 官方像素基线机制：llvmpipe 软件 GL（`--ignore-gpu-blocklist` + `--use-angle=gl`）+ `--force-device-scale-factor=1` + 禁字体亚像素/kerning（`applyTestingStyles`）+ 容差 `maxDiffPixels:1/threshold:0.1`，`--update-snapshots` rebaseline 时零容差防漂移）；fixture 经 `openTraceFile` 文件上传路径加载，基线落 `test/data/ui-screenshots/<测试文件>/<用例>/`。

**fixture（已落库 `test/data/`，smartperfetto 工程授权公开分发的真实 Android trace，均含 `.sha256` 旁车）**：⚠️ **许可为 AGPL-3.0，perfetto 仓库为 Apache-2.0——这 5 份 fixture 仅限本地开发验证**，已通过 `.git/info/exclude` 本地排除，绝不随上游 PR 提交（`test/.gitignore` 的 `!data/*.sha256` 反排除使旁车仍可被 add，但哈希串无版权内容、无害）；**上游 PR 的测试改用官方合成 trace 能力（trace_builder/textproto）构造等价场景**，真实 trace 只做本地最终验证：
`smartperfetto_android_scroll_jank_customer.pftrace`（14M，Android 16 OPPO 真机滚动 jank——**主用例**）、`smartperfetto_android_startup_heavy.pftrace`（18M，重启动）、`smartperfetto_android_startup_light.pftrace`（10M）、`smartperfetto_android_scroll_standard.pftrace`（6.3M）、`smartperfetto_flutter_scroll_surface_view.pftrace`（12M，Flutter 渲染路径）。

**真实参数集（经自编译 `trace_processor_shell` 实测确定，非虚构）**

主用例实测事实：trace 边界 `506729976821104 – 506737792493809`（7.8s）；app 进程 `com.example.wechatfriendforcustomscroller`（pid 13534），其 RenderThread = tid 13585（13,653 条 slice）、主线程名被截断为 `rcustomscroller`（tid 13534）；SF 进程 `/system/bin/surfaceflinger`（pid 2380，线程名普遍 [NULL]——**本身就是 trackNamePatterns 匹配的边界用例**）；`Actual Timeline`/`Expected Timeline` track 存在；21 个 janky frame（与 smartperfetto FPS 报告一致），最差帧 ts=506731892411259 dur=62.7ms（App Deadline Missed + Buffer Stuffing）。startup_heavy：app 首 slice 564166676119845，主线程 tid 21307、RenderThread tid 24786。

| 用例 | timeSpan（ns） | pin / trackNamePatterns | 验证重点 |
|---|---|---|---|
| A1 最差帧聚焦 | `[506731860000000, 506731970000000]`（110ms） | `com.example.wechatfriendforcustomscroller.*(RenderThread\|rcustomscroller)` + `Actual Timeline` + `surfaceflinger` | 深缩放单帧剖面；**边界 slice 断言实锚**：62.7ms 帧横跨窗口、起始早于窗口左界，必须完整显示（§6.4 边界断言的天然样本） |
| A2 jank 簇 | `[506734750000000, 506736000000000]`（1.25s，含 3 个最差帧） | 同上 | 多帧簇 + pin 排序元数据断言（**默认冒烟窗口**） |
| A3 全手势 | `[506731768732822, 506735985833653]`（4.2s，全部 21 jank） | 同上 | 宽窗口数据量 |
| B1 冷启动（startup_heavy） | `[564166676119845, 564169676119845]`（app 首 slice 起 3s） | `launch.aosp.heavy.*(RenderThread\|unch.aosp.heavy)` + `miui.home` | 跨进程 pin（app + launcher） |
| C1 组件开关矩阵 | A2 窗口 | 任意 2 track | `includeTimeAxis/TrackShell/Grid` 取 4 种代表组合：components 元数据断言 + shell 区背景色采样 |

配套断言数据：各窗口内 jank 帧数用 `select count(*) from actual_frame_timeline_slice where jank_type != 'None' and ts between ? and ?` 生成，写死进测试。

**工具链注**：本仓库已编译 `out/mac.release/trace_processor_shell`（`tools/gn gen out/mac.release --args='is_debug=false'` + `tools/ninja -C out/mac.release trace_processor_shell`；构建依赖经代理 `127.0.0.1:7897` 安装），后续新 fixture 的窗口/线程名实测均可用它即时验证。

### 6.2 功能断言（pin 显示 / 组件隐藏的判定依据）

**架构性前提**：离屏输出不是"页面截图"而是全新合成的画布——**侧栏、底栏、弹窗、omnibox 等页面 DOM 组件从未被绘制，"隐藏"是设计保证而非裁剪结果**。输出尺寸 = `ΣtrackHeights(+axis)` 联合求解值，任何页面组件的像素都不可能出现在图里。因此判定分四层，由强到弱：

| 层 | 手段 | 断言内容 | 时机 |
|---|---|---|---|
| 1. 元数据断言（`TimelineImageResult.metadata`） | `trackBoxes`：pin 的 track 的 `y` 最小且按 `pinTracks` 顺序排列；`components`：不含被关闭的组件（`includeTrackShell=false` → 无 `'trackShell'`）；`drawnTexts`：目标 track 名称（如 "SurfaceFlinger"）出现在列表中 | Playwright 集成 + jsdom 单测（mock 渲染） |
| 2. 结构断言（单测） | mock renderer 记录 draw 调用序列：被排除的 track 的 `drawCanvas` 从未被调用；被排除组件的绘制纯函数从未被调用 | vitest/jsdom |
| 3. 像素区域断言 | 采样左侧 `TRACK_SHELL_WIDTH` 宽度矩形：`includeTrackShell=false` 时该区域像素 == 背景色（均值/方差恒定）；`includeTrackShell=true` 时该区域含文本反差 | Playwright |
| 4. golden 基线 | 固定 trace + 固定参数 → 官方像素 diff 机制锁定整图；组合行为（pin 排序+组件开关+时间轴）经一次人审后由基线守护回归 | Playwright，`--update-snapshots` 生成 |

**pin 判定协议**：`pinTracks: [sfUri, rtUri]` 时断言 `metadata.trackBoxes` 中 sfUri 的 `y` 全局最小、rtUri 次之，且相对序等于 `pinTracks` 数组序（§3.4 语义"保持 trackUris 内相对序"）。

### 6.3 用例矩阵（八组）

| 组 | 用例 | 期望 |
|---|---|---|
| 参数边界 | `start==end`（零宽）、`dur<0`、timeSpan 完全超出 trace 两端、`trackUris=[]`（显式空 vs 缺省全集语义差异）、`pinTracks` 含不存在 uri、`trackNamePatterns` 无匹配、`widthPx=1` 与超大值（预算 clamp） | reject（非法）或 CLIPPED/TRACK_NOT_RENDERED/DOWNSCALED warning + 尽力输出；绝不静默成功 |
| 确定性/幂等 | **同参数两次 render → blob 字节级一致**（canvas PNG 无时间戳 chunk，可哈希比对；若有实现层差异则测试侧固定标准化流程）；UI 会话含 selection/notes 时默认参数输出仍一致 | 字节一致 |
| 并发/竞争 | 截图进行中 UI pan/hover（逐出回退，§3.3.3 阶段 B）；并发两请求（BUSY/排队）；截图中 `CloseTrace`/引擎 dispose | 回退成功或 warning；第二请求排队；dispose 后调用 reject |
| 降级 | WebGL 不可用 → Canvas2D 回退 + warning；`perTrackTimeoutMs` 压小触发 partial（棋盘格 + TIMEOUT warning，A2 上做）；超高输出 `stitch=true` 多片元数据拼接 | 失败可见 |
| 协议 | 消息名拼错 → 静默无响应（既有行为，协议文档警示）；非信任 origin 确认框不自动通过；`requestId` 重复/乱序；trace 未就绪时到达（挂起不丢，§3.5(a)）；响应 Blob 字节数 + PNG magic 校验；进度 per-track 节流 | 协议行为逐条锁定 |
| matchUi 不变式 | 同一 timeSpan 两档 widthPx（matchUi）→ 渲染时间范围一致、仅像素宽不同 | 时间语义恒定（§3.3.5） |
| 跨 fixture 冒烟 | 5 份 fixture 全部"加载 → render → 非纯色 + metadata 完整" | 覆盖 protobuf/设备/场景差异 |
| GL 生命周期 | 连续 20 张（含分片）无 context lost；`loseContext()` 重建后可用 | §3.3.4 单例规则验证 |

### 6.4 验收基准与 CI 看护

全部以"实际渲染的 track 数"为口径（与 slice 总数无关，mipmap 保护）：

- 典型 jank 场景（≤10 track、2400px、1s 窗口）：冷缓存 ≤ 5s（CI 机器放宽 ×2；显式 `queryBounds` 生效，冷查询数据量 1x 而非 3x）；
- 同参数二次截图（热缓存）：≤ 1s；
- 截图期间 UI hover 延迟增量 ≤ 单条查询时长。测量协议：同窗口下无截图负载时 hover 查询耗时中位数 = 基线 B；截图进行中重复测量取中位数 B′；断言 `B′ − B ≤ B`；
- 峰值额外内存 ≤ 输出画布位图 × 2；
- 50 track 全量截图：在预算内 partial 降级完成，不挂起、不 OOM；
- **输出图像必须通过"非纯色"断言**（黑屏/空白 canvas 是尺寸合法的失效模式，是 WebGL 读回失败的第一症状）；
- **边界 slice 正确性断言**：用构造 trace（含一条起始早于窗口、贯穿窗口的长 slice；主用例 A1 即天然样本）验证截图包含该 slice——守护 mipmap 算子 back-off 行为的回归（该行为是精确 `queryBounds` 安全性的前提，§3.3.1 事实 2）。

**CI 看护（性能/基线两类劣化的持续检测）**：A2 冒烟用例常驻断言 `result.perf.elapsedMs` 软阈值（验收值 ×2 告警不阻断、×3 阻断合入）+ 趋势记录；像素基线漂移按判定规则处置——**预期内变更**（本方案代码/字体/CSS 修改、官方 UI 改版牵连）附原因分类后允许 `--update-snapshots` 重录，**非预期漂移**（无对应代码变更）必须 root cause、禁止直接重录。

### 6.5 开发期观测与调试（复用 perfetto 自带体系，不自建）

perfetto 已有完整的分层观测体系，开发期全部开启；分阶段耗时统计双轨：API 级 `TimelineImageResult.perf`（宏观，面向调用方/CI）+ metatrace 打点（微观，面向开发定位）。

**开关与用途清单**（均经源码核验）：

| 层 | 开关/入口 | 看什么 |
|---|---|---|
| JS 打点 | `core/metatracing.ts` 的 `traceEventBegin/End`（**当前零调用方，本方案为首个消费者**） | 截图管线分阶段打点（见下），随 metatrace 导出 |
| TP 查询 | `Engine.queryLog`（最近 1024 条含 `elapsedTimeMs`，TP 侧实测）+ 插件 `dev.perfetto.QueryLog` 标签页；`select * from sqlstats`（started/first_next/ended 分段，最近 100 条） | 慢查询定位——截图 mipmap 查询逐条可见 |
| TP metatrace | `Engine.enableMetatrace(categories)` / `stopAndGetMetatrace()`（WASM 与 HttpRpc 同路径透传）；shell 侧 `-m FILE`；flag `alwaysOnMetatracing`/`detailedMetatracing` | 查询内部分解（EXECUTE_QUERY 含 SQL 原文、STMT_STEP、span_join 等） |
| 帧渲染 | 命令 `dev.perfetto.TogglePerformanceMetrics`（右下浮层：rafActions/Canvas/Dom/Total 的 Last/Avg/Avg10） | 截图期间 UI 掉帧归因 |
| 卡死 | feature flag `showTaskTracker`（状态栏任务追踪器） | 任务堆积即卡死现场（截图软退出/单飞队列状态可见） |
| 导出 | 侧边栏 `perfetto.Metatrace` → Record/Finalize；输出 = **TP 字节 + JS 字节拼接的标准 Perfetto proto trace，可直接回载 UI 分析**（"用 perfetto 分析 perfetto"） | 一次导出同时含两侧时间线 |

**截图管线打点设计**（事件名约定，PR 1 随 T1.12 落地）：
`TimelineImage.warmUp[track]`、`TimelineImage.barrier`、`TimelineImage.draw[track]`、`TimelineImage.tile[n]`、`TimelineImage.encode`、`TimelineImage.e2e`——与 `perf` 三段（loadMs/drawMs/encodeMs）一一对应，交叉验证计时正确性。

**自动化开启**（渲染服务/CI 无人工）：URL `?startupCommands=[{"id":"dev.perfetto.TogglePerformanceMetrics"},...]` 在 trace 加载后程序化打开浮层等；metatrace 用 flag `alwaysOnMetatracing` + 页面 reload 生效。

**注意事项**：非 `crossOriginIsolated` 且非 HTTP_RPC 时 WASM 定时器精度 >1ms，亚毫秒事件会被丢弃（现有代码弹窗警告）——打点粒度按 ≥1ms 设计；native TP（HTTP_RPC）路径无此限制（§8.2 部署形态天然规避）。

---

## 7. 实施计划与阶段治理

> 执行进度跟踪见**附录 D 执行跟踪表**（同文档末尾的高频变更区，含五态状态机与失败留痕规则）；本章只定义计划本身，不承载执行状态。

### 7.1 PR 拆分、DoD 与回滚

```
PR 0（纯重构前置，零行为变化）
  ├─ 依赖：无（可与 feature issue 并行）
  ├─ Scope：仅"提取 TrackTreeView 绘制序列为纯函数"（原 PR 1 的重构项）
  ├─ DoD：官方像素基线无 diff（零行为变化的最强证明）；diff 机械、易审
  ├─ 演示物：无（纯内部重构）
  ├─ sizing：~3–5 天
  └─ 回滚影响：极低（revert 即回到原状）
     目的：提前稳定 §7.2 冲突高发点①，显著缩小 PR 1 的 diff——大 PR 是上游接受的负向因子
PR 1（L1+L2 原语，无外部入口）
  ├─ 依赖：PR 0、feature issue 沟通结论
  ├─ Scope：public/timeline_image.ts + core/timeline_image_manager.ts + Trace 接口扩展；
  │          Timeline 插件内 offscreen_timeline_renderer.ts（两段式 + 竞争防护/定点迭代 +
  │          WebGL 默认后端 + GL 单例/preserveDrawingBuffer 读回）并注册进管理器；
  │          接口增量 queryBounds/whenDataReady（slice/counter 采用，其余回退）
  ├─ DoD：单测全绿；Playwright 全链路（A2 窗口）像素 diff 基线入库；§6.4 全部断言通过；
  │        接口变更在 PR 描述显式声明 + 插件文档同步；eslint/prettier 通过
  ├─ 演示物：DevTools 控制台一行 trace.renderTimelineImage({...}) 出图（开发者可用）
  ├─ sizing：~3–4 周（重构已前移 PR 0）
  └─ 回滚影响：低——全部为新增文件 + 可选接口成员；回滚 = 删文件 + 删可选成员，
     UI 主路径零残留（提取的纯函数保留亦无害）
PR 2（postMessage 入口）
  ├─ 依赖：PR 1 的 public API 与消息处理所需类型
  ├─ Scope：renderTimelineImage/Progress/Result 消息 + trace 未就绪挂起（Blob 直传）；
  │          docs/visualization/embedding-api-reference.md 增补
  ├─ DoD：§6.3 协议组用例全绿；Blob 字节数+magic 校验；进度节流验证
  ├─ 演示物：本地 Node/Python 脚本一条 postMessage 取回 PNG（外部程序可用的最早里程碑）
  ├─ sizing：~1–1.5 周
  └─ 回滚影响：低——单文件 if 分支 + 文档
PR 3（入口完备性与性能收尾）
  ├─ 依赖：PR 1（command/MCP 均调 L2）；MCP 需与维护者对齐后启动
  ├─ Scope：Command + 截图下载 UI；MCP tool（对齐后）；trackNamePatterns、URL 便利入口（可选）
  ├─ DoD：§6.4 验收基准全量通过并固化为 CI 看护；§6.3 八组用例全绿；基线 rebaseline 按判定规则执行
  ├─ 演示物：渲染服务样板（长驻 headless + §8.2 native TP 流水线）跑通 5 fixture 批量出图
  ├─ sizing：~2–3 周（不含 MCP；MCP 视对齐结果另计）
  └─ 回滚影响：低——command/便捷参数均为增量
推进顺序：feature issue（M0）与 PR 0（M1a）并行先行 → PR 1 → PR 2 → PR 3；
任一 PR 合入即有独立价值，中途停止无半成品残留。
```

### 7.2 上游演进劣化处置（rebase 节奏与冲突高发点）

跟 upstream 每月 rebase 一次 + 全量回归（八组用例 + 基线 + CI 软阈值）。冲突高发点清单：① 提取的绘制纯函数（TrackTreeView 改版必冲突）② `TrackRenderContext`/`TrackRenderer` 接口 ③ `post_message_handler` if 链 ④ mipmap 算子边界行为（边界 slice 断言守护）。冲突按本方案 §3.3 语义手工合入；官方若重构算子语义，边界断言失败即触发重新评估 §3.3.1 事实 2。

### 7.3 上游贡献流程要点

- **先开 feature issue**（引用 #2266 embedding 方向 + MCP 方向）与维护者对齐，再投 PR
- PR 指向 `stevegolton@google.com` review；插件目录含 `OWNERS`
- 代码风格过 `ui/eslint`、`ui/prettier`；TS 风格遵守 `docs/AGENTS-ui.md`（`readonly T[]`、禁 `any`、`assertUnreachable()` 等）
- 任何视觉影响跑像素 diff 并提交新基线（WebGL 基线）

---

## 8. 部署与运维

### 8.1 信任模型硬约束

postMessage 自动化要求 UI 页面 origin 为 localhost（`isTrustedOrigin()` 永远信任）或用户已授权的宿主 origin。因此**渲染服务与 UI 必须同机部署**：headless Chrome 加载 `http://localhost:<port>` 的自托管 UI（官方发布产物或自构建），服务进程经 PING/PONG + postMessage 驱动。跨机器的"远程截图服务"首版不支持（需要授权 UX 配合，不做）。既有风险如实声明：localhost 信任意味着本机任意网页理论上可向该 UI 发送消息——这与现有 PostedTrace/scrollToTimeRange 的暴露面相同（截图内容 ⊆ trace 内容），本 API 不扩大既有风险面，部署文档需明示。

### 8.2 加载加速流水线（既有特性，不改 perfetto 源码即可用）

截图 API 只能消除"加载后的渲染成本"；trace 解析成本（R7）由以下既有机制压缩，推荐部署形态自下而上叠加：

```
trace.pftrace
  → trace_processor export perfetto -o parsed.tar    # ① 一次性预解析（可选）
  → trace_processor_shell --httpd parsed.tar          # ② native 加载，UI 零字节传输
  → headless 渲染服务（自动探测 9001 端口）截图出图
  → 长驻进程处理同 trace 的 N 张截图（同参数 memo 命中）
```

1. **native TP 自动切换（已内置，无需按文件大小判断）**：engine 创建默认 `USE_HTTP_RPC_IF_AVAILABLE`（`load_trace.ts` `createEngine()`），自动探测本机 9001 端口（`rpc_port` 参数可改），探到即用 `HttpRpcEngine`，否则回退 WASM。native 路径利用 SSE、不受浏览器 ~2GB 内存限制（proto trace 运行时膨胀 2–4x，`docs/visualization/large-traces.md`）。
2. **零传输加载**：trace 由 TP 从命令行参数加载时，UI 走 RPC 模式不上传文件字节（HTTP_RPC source 的 traceStream 为 undefined，直接进入加载完成态）——GB 级 trace 最大的单项加速。
3. **export perfetto 预解析**：导出已解析静态表，重开时跳过 ingestion + sorting 全流程（另有 shell sessions 免重解析）。浏览器缓存只存原始字节（重开仍需重新 parse），解析结果持久化只能靠这条 TP 侧路径。
4. **TraceProcessorConfig 调优**（UI 已暴露）：`ingestFtraceInRawTable: false`（`--no-ftrace-raw`，显著降内存/加速，raw 表截图渲染用不到）；`forceFullSort` 保持关闭（全量排序是负向开关）。
5. **多实例并行**：多个 `--httpd` 不同端口 + `rpc_port` 参数，渲染服务可并行处理多份 trace。
6. **流式 ingest**：`?url=` 场景 32MB 分块边下边解析（`trace_stream.ts`），下载与解析重叠，已默认。

### 8.3 渲染服务形态与资源回收

长驻 headless Chrome（复用 trace 加载与 memo 缓存，摊薄 R7），配 §8.2 的 native TP 实例；多 trace 并行 = 多 TP 端口 × 多页面实例。对外暴露简单的 HTTP 接口（收参数 → 转发 postMessage → 收 Blob → 返回图像），这部分属调用方基建，不进 perfetto 上游。资源回收：每 trace 处理完 `CloseTrace`/页面 reload，防止长驻进程内存累积；图像经临时目录/对象存储落地，页面内存中的 canvas 立即释放。

### 8.4 CI 用法

固定 trace + 固定参数 + WebGL 后端 → 像素 diff 基线，与官方 `test/data/ui-screenshots` 流程同构（§6.1/§6.4）。

### 8.5 看护指标与运行时劣化处置（调用方基建，不进上游）

**导出指标**：单图耗时 P50/P95（按 fixture 分档）、`perf` 三段耗时分布、缓存命中率、GL context 年龄（累计截图数）、页面 RSS、错误分类计数（TIMEOUT/BUSY/引擎 dispose）；看板 + 阈值告警。

**运行时劣化处置**：P95 劣化 → 看缓存命中率（缓存失效？）→ GL 年龄（状态累积？）→ RSS（泄漏？）；阈值触发自动 reload 页面（§8.3 资源回收的主动版）；GL 年龄超限主动 `loseContext()` 重建；连续失败数超限告警。看护积累的阶段占比数据同时是 §5.4 优化闭环的输入（服务端 top-down 归因）。

---

## 9. 风险与开放问题

1. **维护者接受度（最大上游风险）**：图像导出无先例，官方历史立场是"UI 自动化走 commands/deep-link"。缓解：先开 issue；PR 1 聚焦原语且接口变更透明；同时展示 MCP 入口选项（对齐官方正在投入的方向）；强调与既有 postMessage 协议的同族性（`scrollToTimeRange` 先例）。
2. **track renderer 私有状态**：个别官方 track 的 `render()` 若读取会话态（hover 等），离屏路径需逐 track 验证；首版以核心 track（slice/counter/Sched/Frames/DisplayLog）为验证白名单，遇私有依赖按反模式清单修复。
3. **接口变更的 review 阻力（D2）**：`queryBounds` + `whenDataReady` 均为可选成员，但 slice/counter 采用 `whenDataReady` 仍横跨 renderer 文件，可能被要求拆得更细；备选 instanceof 白名单方案在 issue 讨论中二选一。
4. **WebGL→2D 合成的保真度**：`drawImage` 合成需验证 toBlob 后色彩空间（colorSpace）与 GL canvas 一致；PR 1 专项验证项。
5. **响应体大小**：2400×800 PNG 约 0.5–2MB，Blob 结构化克隆直传；超大图受 §5.3 第 4 条画布上限约束，尺寸可控。
6. **mipmap 算子行为的隐性依赖**：精确 `queryBounds` 的正确性依赖算子内置 back-off/carry-in（§3.3.1 事实 2）——这是 C++ 层行为，UI 侧改动不触发，但若上游未来重构算子语义，边界 slice 断言（§6.4）是唯一守护。
7. **feature flag 门控（开放，issue 讨论项）**：维护者可能要求新能力（尤其 whenDataReady 接口增量）以 experimental flag 门控渐进启用——随 T0.2 一并询问。

---

## 附录 A：关键源码索引（main@4b69bf97，以符号名为主——行号随上游演进会漂移）

- 渲染分层：`ui/src/core_plugins/dev.perfetto.Timeline/`（`timeline_page.ts` `renderPinnedTracks`、`track_tree_view.ts` `drawCanvas/drawTracks`（private，绑 Mithril 生命周期）、`track_view.ts` `drawCanvas/getTrackHeight`（public 可复用））、`ui/src/widgets/virtual_overlay_canvas.ts`（WebGL 优先创建）、`ui/src/base/`（`virtual_canvas.ts`、`renderer.ts`、`time_scale.ts`、`canvas2d_renderer.ts`、`gl/webgl_renderer.ts`）
- 分层规则与先例：`docs/ui-review-antipatterns.md`（架构与分层节）、minimap 注册反转模式（`public/minimap.ts` → `core/minimap_manager.ts` → Timeline 插件注册）——本方案 L1/L2 落位的直接参照；`core/` 无 import `core_plugins` 先例
- track 接口：`ui/src/public/track.ts`（`TrackRenderContext.resolution` 既有必填字段、`TrackRenderer.render/getHeight`、`getSelectionDetails` 可选 Promise 方法先例）；`Trace` 实现模式：`core/trace_impl.ts`（`scrollTo` 委托、内联管理器字段、`createFakeTraceImpl` 复用）
- 调度：`ui/src/core/raf_scheduler.ts`（`raf` 单例、`addCanvasRedrawCallback`）
- 时间范围状态：`ui/src/core/timeline.ts`（`setVisibleWindow`、`panSpanIntoView`）
- pin 机制：`ui/src/public/workspace.ts`（`pinTrack/unpinTrack/pinnedTracks`）
- 数据加载：`ui/src/components/tracks/slice_track.ts`（mipmap 建表与查询、`useData` 消费 `ctx.resolution`、incomplete slices 重叠语义 SQL）、`counter_track.ts`（min/max 桶降采样、carry-in 钳零）、`buffered_bounds.ts`（3x 量化）、`ui/src/base/async_memo.ts`（`use()` 同步快照、TASK_CANCELLED 不外泄自动重试、pending promise 不暴露）
- mipmap 算子（C++，边界行为关键）：`src/trace_processor/plugins/slice_mipmap_operator/slice_mipmap_operator.cc`（窗口左边界 back-off 一步）、`counter_mipmap_operator.cc`（显式 carry-in）
- 查询执行：`ui/src/trace_processor/engine.ts`（单 worker 线性化）、`wasm_engine_proxy.ts`
- 深链接/路由：`ui/src/public/route_schema.ts`（`ROUTE_SCHEMA`）、`ui/src/plugins/dev.perfetto.DeeplinkQuerystring/`
- postMessage：`ui/src/frontend/post_message_handler.ts`（if/return 链、`isTrustedOrigin`、`scrollToTimeRange` 200ms×20 重试后放弃、`keepApiOpen`/`readyState` 前置条件、PostedTrace）；trace 就绪单例：`core/app_impl.ts`（`AppImpl.instance`、`openTraceFromBuffer`）
- 加载：`ui/src/core/load_trace.ts`（`createEngine`、TraceProcessorConfig、HTTP_RPC 零传输）、`ui/src/trace_processor/http_rpc_engine.ts`（`checkConnection`）、`ui/src/core/trace_stream.ts`
- 状态序列化：`ui/src/core/state_serialization.ts`
- 调试/观测体系（§6.5）：`ui/src/core/metatracing.ts`（traceEvent API，环形 buffer，零调用方）、`core/perf_stats.ts` + `core/perf_manager.ts`（`dev.perfetto.TogglePerformanceMetrics`）、`ui/src/trace_processor/engine.ts` `queryLog`/`enableMetatrace`/`stopAndGetMetatrace`、`plugins/dev.perfetto.QueryLog`、TP `sqlstats` 表（`plugins/sql_stats_table/`）、shell `-m/--metatrace`（`trace_processor_shell.cc`、`shell/metatrace.cc`，categories: query_toplevel/detailed/function_call/db/api）、flag `alwaysOnMetatracing`/`detailedMetatracing`/`showTaskTracker`（`core/feature_flags.ts`）、导出拼接 `frontend/trace_actions.ts` `finaliseMetatrace`
- MCP：`ui/src/plugins/com.google.PerfettoMcp/`
- 命名避让：`ui/src/plugins/dev.perfetto.Screenshots/`（Android 截图 track 插件，public 层命名 `renderTimelineImage` 的原因）
- 测试：`ui/vitest.config.mjs`、`ui/playwright.config.ts`（llvmpipe + `--use-angle=gl` + `force-device-scale-factor=1` launch args、`maxDiffPixels:1/threshold:0.1` 容差、rebaseline 零容差）、`ui/src/test/perfetto_ui_test_helper.ts`（`applyTestingStyles` 字体稳定化、`waitForPerfettoIdle`、`openTraceFile` 文件上传路径）、fixture 惯例 `test/data/` 顶层 + `.sha256` 旁车、基线 `test/data/ui-screenshots/<测试文件>/<用例>/`
- 贡献规范：`docs/AGENTS-ui.md`、`docs/ui-review-antipatterns.md`、`docs/contributing/{getting-started,ui-plugins,testing}.md`、`docs/visualization/{embedding-api-reference,ui-automation,large-traces}.md`

## 附录 B：决策记录（ADR）

| # | 决策 | 理由 | 首定/修订版本 |
|---|---|---|---|
| 1 | L1 不放 `core/`，放 Timeline 插件内 + minimap 注册反转落位 | core→core_plugins 全树零先例，违反官方分层反模式 | v5 |
| 2 | 撤销"queryBounds 必须带左侧回看 padding" | mipmap 算子 C++ 内置 back-off/carry-in，精确 bounds 数据安全（源码实测） | v5 |
| 3 | 不新增 resolution 接口字段 | `TrackRenderContext.resolution` 既有必填且数据路径已消费，dpr 解耦零接口变更 | v5 |
| 4 | 撤销 `capabilities` 能力声明 | 随 #3 简化：未采用 queryBounds 仅性能差异无正确性差异，whenDataReady 有回退语义 | v5 |
| 5 | postMessage 响应默认 Blob，不用 base64/分块 | 结构化克隆原生支持 Blob，体积/CPU 双优 | v3 |
| 6 | URL 深链接降级为"下载链接+通知" | 顶层窗口无回传目标、无手势下载被拦、headless 无人点击，取图闭环不成立 | v2 |
| 7 | Bigtrace 不适用 | 独立应用（无时间线/track/mipmap 渲染），定位是 trace 集合的分布式 SQL 查询 | v2 |
| 8 | Playwright 外部方案保留为过渡兜底 | 反向受益于新 API；正式替代以 §1.4 指标达成为准 | v1 |
| 9 | 接口增量收敛为 queryBounds + whenDataReady 两项可选成员 | 三卡同根问题经源码深验后大幅简化（v3 曾设计 resolution 字段 + capabilities 声明） | v5 |
| 10 | 输出元数据（trackBoxes/components/drawnTexts）进 public API | 功能断言需可编程依据；shell 文本 fillText 绘制无 DOM 可查 | v6 |
| 11 | 拆出 PR 0（纯重构）先行 | 缩小 PR 1 diff（大 PR 是上游接受负向因子）；提前稳定冲突高发点① | v9.2 |
| 12 | AGPL fixture 仅限本地，上游测试用合成 trace | AGPL-3.0 数据不能进 Apache-2.0 上游仓库（许可证污染） | v9.2 |
| 13 | 观测复用 perfetto 既有体系（traceEvent/queryLog/sqlstats/metatrace），不自建计时 | traceEvent API 零调用方可直接成为首个消费者；TP 侧计时为实测值；metatrace 输出即 proto trace 可回载分析 | v9.3 |

## 附录 C：修订史

| 版本 | 日期 | 摘要 |
|---|---|---|
| v1 | 2026-08-22 | 初版：三层架构、性能设计、加载流水线（三轮逻辑 review 后定稿） |
| v2 | 2026-08-22 | 首轮 review 修订：缓存命中修正、加载/绘制解耦、WebGL 后端决策、URL 入口降级、MCP 入口、部署约束 |
| v3 | 2026-08-22 | 二轮 review 修订：渲染上下文显式化、WebGL 读回/context 复用、matchUi 不变式、Blob 响应、成本模型 3x 系数 |
| v4 | 2026-08-22 | 三轮 review 修订：padding 回看、能力声明、barrier 同任务绘制、定点迭代、基线环境前置核实 |
| v5 | 2026-08-23 | 深度验证轮：mipmap 算子边界行为实测（撤销 padding 论断）、minimap 模式落位（修复分层倒置）、resolution 既有字段（撤销接口变更）、AsyncMemo 取消语义、postMessage 排队语义、官方基线机制核实、改名 renderTimelineImage |
| v6 | 2026-08-23 | 渲染元数据入 API、四层功能断言、5 份真实 fixture 落库 |
| v7 | 2026-08-23 | 自编译 trace_processor_shell 实测真实参数集（A1–C1）、八组补充用例清单 |
| v8 | 2026-08-23 | 计划质量要素补齐：DoD/依赖图/sizing/回滚、四类劣化处置矩阵、看护指标、用户层成功指标、ADR、non-goals |
| v9 | 2026-08-23 | 结构重组定稿：选型前移、测试聚合（§6）、加载流水线归部署（§8.2）、清除正文版本标记、TL;DR、去重（matchUi/边界断言/信任模型收敛至唯一权威位置）、ADR/修订史入附录 |
| v9.1 | 2026-08-23 | 执行跟踪并入本文档为附录 D（原独立 EXECUTION.md 撤销；单文档原则），设"对外分享截至附录 C"分界；正文零改动 |
| v9.2 | 2026-08-23 | 末轮疏漏修复：AGPL fixture local-only + 上游合成 trace（ADR12）、拆 PR 0（ADR11）、postMessage 队列上限与失败清空、trackNamePatterns ReDoS 防护、locale 确定性验证（T1.11）、测试环境任务（T1.0）、feature flag 讨论项 |
| v9.3 | 2026-08-23 | 新增 §6.5 开发期观测与调试（ADR13：复用 traceEvent/queryLog/sqlstats/metatrace，截图管线打点设计，双轨耗时统计）；D.4 产物增 querylog/metatrace；任务 T1.12 |
| v9.4 | 2026-08-23 | 新增 §5.4 性能优化方法论与杠杆清单（top-down 闭环：测全链路→阶段归因→攻大头→单变量→复测；16 项杠杆按阶段分组，含渲染服务真机 GPU/ANGLE 杠杆及像素一致性权衡）；§1.4/§8.5 交叉引用 |

---

## 附录 D：执行跟踪表（Execution Tracker）

> ⚠️ 本附录起为**执行跟踪区（高频变更）**：任务状态一变即更新，随对应 commit/PR 提交；正文（§0–§9 + 附录 A–C）为设计定稿区，只经 ADR/修订史变更。**对外分享或提交上游时，本文档截至附录 C。**
> **阶段声明（2026-08-23）**：当前处于**开发验证阶段**——上游 issue/PR 流程（M0 及 §7.3）⏸ 暂缓，本地先行开发验证；PR 0–3 在本阶段交付物为**分支/commit**（不推上游）。恢复条件：本地验证产出可演示效果后重启 M0。
> 里程碑指针：**当前 = M1a（PR 0 重构）+ M1（PR 1 本地开发验证）；M0 ⏸ 暂缓**

### D.0 日常执行工作流（总览）

```
内环（单任务，天级）
  ① 领任务    附录 D.2 表 ⬜→🔵；先查：依赖任务已 ✅？验收标准可判定？
              （不可判定 → 先回正文补 DoD，规则见 D.3）
  ② 开发      网络操作带代理；观测常开（§6.5：metatrace/queryLog/perf 浮层）
  ③ 自测      产物落 out/test-runs/<时间戳>-<标签>/（D.4 六件套，
              断言失败必含原因字段）
  ④ 提交      代码与任务状态同 diff：→✅ 附 commit/PR 链接；
              →❌ 留三要素（原假设/证据/替代路径）+ 新增 ADR 到附录 B
  ⑤ 里程碑门  D.1 验收门全过 → 移动文首"当前"指针

外环（持续）
  CI 看护常驻（§6.4 软阈值 + 像素基线）｜每月 rebase upstream + 全量回归
  （§7.2）｜渲染服务上线后叠加 §8.5 看护指标

变更流（执行触发设计修订的唯一通道）
  发现设计问题 → 任务 ⛔/❌ → ADR（附录 B）+ 修订史（附录 C）
  → 正文相应章节更新；正文永不因执行状态被直接改写
```

### D.1 里程碑总控（PR 级）

| 里程碑 | 内容 | 验收门（DoD 摘要，详 §7.1） | 状态 | 产出物 |
|---|---|---|---|---|
| M0 | feature issue 与维护者对齐 | issue 建立、接口增量获初步反馈、instanceof 白名单备选二选一有结论、feature flag 门控偏好有结论 | ⏸ 暂缓（开发验证阶段先行，见文首阶段声明） | issue 链接：— |
| M1a = PR 0 | 纯重构前置（提取绘制序列） | 官方像素基线无 diff | ⬜ | PR：— |
| M1 = PR 1 | L1+L2 原语（依赖 PR 0） | 单测全绿；A2 全链路像素基线入库；§6.4 断言全过；接口变更声明+插件文档 | ⬜ | PR：— |
| M2 = PR 2 | postMessage 入口 | §6.3 协议组全绿；Blob 校验；进度节流；协议文档更新 | ⬜ | PR：— |
| M3 = PR 3 | 入口完备性+性能收尾 | §6.4 验收基准全量通过并固化为 CI 看护；八组用例全绿；渲染服务样板跑通 5 fixture | ⬜ | PR：— |

### D.2 任务表

#### D.2.1 M0（issue 沟通）+ M1a（PR 0 重构）——两项并行先行

| ID | 任务 | 验收标准 | 依赖 | 状态 | 产出物 | 备注 |
|---|---|---|---|---|---|---|
| T0.1 | 提交 feature issue（引 #2266 + MCP 方向，附方案精简版） | issue 建立 | — | ⏸ | — | 开发验证阶段暂缓；恢复条件=本地可演示效果产出 |
| T0.2 | 接口增量对齐（queryBounds/whenDataReady vs instanceof 白名单）+ feature flag 门控偏好 | 维护者表态，记录结论 | T0.1 | ⏸ | — | 同上暂缓；结论回写附录 B 新 ADR |
| T0.3 | **M1a = PR 0**：提取 TrackTreeView 绘制序列为纯函数 | UI 主路径行为零变化（官方像素基线无 diff） | — | ✅ | commit t0.3-extract-draw-sequence | §3.3.6 要点 4；2026-08-23 完成：新文件 timeline_canvas_renderer.ts + TrackTreeView 委托；tsc/eslint/prettier/vitest(6/6) 全绿；**A/B 证明**：改前/改后 load_and_tracks "load trace" 截图 SHA256 逐字节一致（out/test-runs/preref-actual.png vs postref-actual.png，6c48de7b…）。注：官方像素基线在 macOS 原生环境必然 diff（Linux Docker 生成），本机验证采用 A/B 自对比法（更强）；CI/Linux 环境回归官方基线 |

#### D.2.2 M1 = PR 1：L1+L2 原语

| ID | 任务 | 验收标准 | 依赖 | 状态 | 产出物 | 备注 |
|---|---|---|---|---|---|---|
| T1.0 | UI 测试环境搭建（node_modules、`ui/run-integrationtests`） | 本地跑通任一官方既有 Playwright 用例（环境可信基线）；确认 fork 侧 CI（GitHub Actions）可跑 UI 集成测试 | — | 🔵 | 环境记录 | §6.4 CI 看护载体；2026-08-23 依赖经代理装毕；官方用例验证与 fork CI 确认待做（未达验收不得标 ✅） |
| T1.2 | AsyncMemo 暴露 pending 完成 Promise | whenDataReady 可基于其实现；既有 use() 行为零变化 | — | ✅ | commit pr1-timeline-image | §3.3.1 事实 3；新增 AsyncMemo.waitFor()（单次调度 + settle 信号循环，key 被替换/invalidate/dispose 均正确解除等待），单测 18/18 过（新增 5 例） |
| T1.3 | 接口增量：`queryBounds` + `whenDataReady?` | 可选成员、缺省行为不变；插件文档同步 | — | ✅ | commit pr1-timeline-image | §3.3.2；TrackRenderContext.queryBounds（性能提示语义）+ TrackRenderer.whenDataReady?（不 reject、未实现=立即就绪）；tsc/eslint/prettier 过；插件文档（docs/visualization/extending-the-ui）随 PR 2 文档任务一并更新 |
| T1.4 | slice/counter track 采用 whenDataReady + queryBounds | 离屏数据就绪可等待；查询量 1x | T1.3 | ⬜ | commit | |
| T1.5 | offscreen_timeline_renderer 两段式（warm-up → barrier → render + 定点迭代） | A2 窗口全链路出图、无棋盘格 | T0.3, T1.2–T1.4 | ⬜ | commit | §3.3.3 |
| T1.6 | GL context 单例 + `preserveDrawingBuffer` 读回 | 连续 20 张无 context lost；非纯色断言过 | T1.5 | ⬜ | commit | §3.3.4 |
| T1.7 | public/timeline_image.ts + core/timeline_image_manager.ts + Trace 挂载 | 控制台 `trace.renderTimelineImage({...})` 出图；Timeline 缺席时 TIMELINE_UNAVAILABLE | T1.5 | ⬜ | commit | minimap 模式，§3.2 |
| T1.8 | jsdom 单测（布局/预算/TimeScale/校验/warning） | 全绿；mock memo 覆盖超时软退出 | T1.7 | ⬜ | `*_unittest.ts` | D9 分层 |
| T1.9 | Playwright 全链路 + 基线 + 功能断言 | A1–C1 通过（本地真实 fixture）；**上游 PR 内用合成 trace 等价场景**；基线入库（合成 trace 基线） | T1.6, T1.7 | ⬜ | 基线 png | §6.1：AGPL fixture 仅限本地 |
| T1.10 | WebGL 读回专项（colorSpace 一致性 + 大图 toBlob） | 两条读回路径输出一致 | T1.6 | ⬜ | 测试 | §9 风险 4 |
| T1.11 | locale 确定性验证（时间轴 label 格式化路径） | 确认/强制 root locale，跨机 diff 稳定 | T1.9 | ⬜ | 测试 | D7 |
| T1.12 | metatrace 埋点接入（traceEventBegin/End，事件名按 §6.5 约定） | 导出的 metatrace 含 warmUp/barrier/draw/encode 分段时间线，与 result.perf 交叉验证一致 | T1.6, T1.7 | ⬜ | commit | §6.5；traceEvent API 首个消费者 |

#### D.2.3 M2 = PR 2：postMessage 入口

| ID | 任务 | 验收标准 | 依赖 | 状态 | 产出物 | 备注 |
|---|---|---|---|---|---|---|
| T2.1 | 消息分支 + trace 未就绪挂起 | §6.3 协议组全绿；PONG 后到达不丢 | T1.7 | ⬜ | commit | §3.5(a) |
| T2.2 | 协议文档（embedding-api-reference.md 增补） | 消息定义/前置条件/静默失败警示齐备 | T2.1 | ⬜ | docs | |
| T2.3 | 外部脚本验证（Node/Python 一条消息取回 PNG） | 本地演示通过 | T2.1 | ⬜ | 示例脚本 | M2 演示物 |

#### D.2.4 M3 = PR 3：入口完备性与性能收尾

| ID | 任务 | 验收标准 | 依赖 | 状态 | 产出物 | 备注 |
|---|---|---|---|---|---|---|
| T3.1 | Command（RenderScreenshot / OfSelection）+ 下载 UI | 命令面板可用人肉出图 | M1 | ⬜ | commit | |
| T3.2 | MCP tool（对齐后） | MCP 调用返回 image content | T0.2 结论 | ⬜ | commit | server 架构先核实，§3.5(c) |
| T3.3 | trackNamePatterns | 按名选 track；SF [NULL] 线程名边界用例过 | M1 | ⬜ | commit | §6.1 A1 参数集 |
| T3.4 | 性能验收 + CI 看护固化 | §6.4 基准全过；软阈值（×2 告警/×3 阻断）入库 | M1 | ⬜ | CI 配置 | |
| T3.5 | 渲染服务样板（长驻 headless + §8.2 流水线） | 5 fixture 批量出图成功 | T2.3 | ⬜ | 样板仓库 | 调用方基建，不进上游 |
| T3.6 | 全场景回归 + rebaseline 判定流程落地 | 八组用例全绿；rebaseline 规则写入贡献文档 | T3.4 | ⬜ | — | §6.4 判定规则 |

**性能优化杠杆的任务化原则**：§5.4 杠杆清单按 top-down 闭环**条件触发**（先测基线、归因后再立项），不预设为任务；被选中的杠杆在 D.2.4 追加编号任务（T3.7+），未选中的保持清单态。by-design 杠杆无需立项（随 PR 1 自然获得）。

### D.3 状态图例与更新规则

- **状态**：⬜ 待办 → 🔵 进行中（备注负责人/起始日）→ ✅ 完成（产出物列必填 PR/commit/文件链接）；⛔ 受阻（备注原因+阻塞项）；⏸ 暂缓（备注恢复条件，外部决策类推迟用）；❌ 已否决（**永不删行**：备注三要素——原假设/证据/替代路径，并新增 ADR 到附录 B）。
- **更新时机**：状态一变即更，随对应 commit/PR 提交（与代码同 diff，可追溯）。
- **验收标准不可判定的任务不允许开始**——先回正文补 DoD。
- **里程碑指针**随阶段推进更新；验收门（§7.1）全过才可移动。
- **与正文的关系**：本附录只引用章节号不复制内容；正文变更走 ADR + 修订史（附录 B/C）。

### D.4 测试产物与运行记录规范

**两类产物、两种规则**：

| 产物 | 位置 | 命名 | 进 git |
|---|---|---|---|
| Golden 基线（像素 diff 比较基准） | `test/data/ui-screenshots/<测试文件>/<用例>/`（官方 snapshotPathTemplate） | 固定路径，**绝不时间戳**（diff 按稳定路径寻址；rebaseline 用 `--update-snapshots` 原地覆盖，变更原因按 §6.4 判定规则记 PR） | ✅ |
| 每次运行产物（截图输出/断言结果/perf/失败 actual 图） | `out/test-runs/<YYYYMMDD-HHMMSS>-<label>/`（`/out*` 已 gitignore） | **时间戳 + 语义标签**（如 `20260823-142510-jank-A2`），配 `out/test-runs/latest` 软链指向最近一次 | ❌ |

运行目录结构件：`run.json`（用例 ID/trace fixture/git rev/GL 后端/dpr 等环境）、`assertions.json`（逐条断言结果，**失败必须含原因字段**，对齐 D.3 失败留痕）、`metadata.json`（`TimelineImageResult` 的 warnings/perf/trackBoxes 原样落盘，供 §6.4 趋势与 §8.5 看护消费）、`querylog.json`（§6.5：该次运行触发的全部 SQL 与耗时，来自 `engine.queryLog`）、`metatrace.pb`（可选，§6.5：问题复现时导出，标准 proto trace 可回载 UI）、`*.png`。保留策略：最近 50 次或 30 天、空间上限 2GB，超出自动清理最旧。渲染服务的批量产物不进本仓库（走临时目录/对象存储，§8.3）。
