# 冒烟测试结果（参数经人工审核批准 · 2026-08-23 v9.24）

> 截图目录（点击文件名可看）：[results/REPORT-ASSETS/smoke/](../results/REPORT-ASSETS/smoke/)
> 命令：[smoke.mjs](smoke.mjs)（数据 [smoke.json](../results/REPORT-ASSETS/smoke/smoke.json)）
> **参数变更须先经人工审核**（PLAN D.0 审核门）。

## S1 零参数默认 `renderTimelineImage({widthPx: 1200, devicePixelRatio: 1})`
语义（本轮经用户批准）：默认全部可见 track，**高度上限 2160px**，超出截断 + `TRUNCATED` warning（全量需显式 trackUris）。

| Fixture | 尺寸 | track | warnings | 截图 |
|---|---|---|---|---|
| example | 1200×2168 | 69 | TRUNCATED | [example-default.png](../results/REPORT-ASSETS/smoke/example-default.png) |
| jank_customer | 1200×2179 | 64 | TRUNCATED | [jank_customer-default.png](../results/REPORT-ASSETS/smoke/jank_customer-default.png) |
| scroll_standard | 1200×2144 | 63 | TRUNCATED | [scroll_standard-default.png](../results/REPORT-ASSETS/smoke/scroll_standard-default.png) |
| startup_heavy | 1200×2160 | 65 | TRUNCATED | [startup_heavy-default.png](../results/REPORT-ASSETS/smoke/startup_heavy-default.png) |
| startup_light | 1200×2178 | 66 | TRUNCATED | [startup_light-default.png](../results/REPORT-ASSETS/smoke/startup_light-default.png) |
| flutter_scroll | 1200×2144 | 63 | TRUNCATED | [flutter_scroll-default.png](../results/REPORT-ASSETS/smoke/flutter_scroll-default.png) |

## S2 关键区间组（每份 trace 专属参数，依据见"窗口依据"列）

| Fixture | 关键线程（置顶） | 窗口依据 | 尺寸 | track | warnings | 截图 |
|---|---|---|---|---|---|---|
| example | RenderThread 4543 | 用户用例 G-E1（slice[95635..115701]） | 1600×685 | 20 | 无 | [example-tuned.png](../results/REPORT-ASSETS/smoke/example-tuned.png) |
| jank_customer | RenderThread 13585 | A2 jank 簇（最差帧 62.7ms） | 1600×557 | 16 | 无 | [jank_customer-tuned.png](../results/REPORT-ASSETS/smoke/jank_customer-tuned.png) |
| scroll_standard | RenderThread 7151 | 最长 slice 22.8ms ±500ms | 1600×480 | 17 | 无 | [scroll_standard-tuned.png](../results/REPORT-ASSETS/smoke/scroll_standard-tuned.png) |
| startup_heavy | RenderThread 25600 | 最长 slice 1.34s ±500ms | 1600×504 | 18 | 无 | [startup_heavy-tuned.png](../results/REPORT-ASSETS/smoke/startup_heavy-tuned.png) |
| startup_light | RenderThread 2131 | 最长 slice 1.05s ±500ms | 1600×612 | 18 | 无 | [startup_light-tuned.png](../results/REPORT-ASSETS/smoke/startup_light-tuned.png) |
| flutter_scroll | 1.raster 10627 + 1.ui 10626 | flutter 线程模型 + 最长 slice ±500ms | 1600×672 | 20 | 无 | [flutter_scroll-tuned.png](../results/REPORT-ASSETS/smoke/flutter_scroll-tuned.png) |

公共参数：全部 CPU 的 freq+sched（运行时收集实际数量，非人工子集）+ 关键线程 pin 置顶 + `widthPx: 1600`。

## 结论
- **12/12 通过**：S1 全部按新默认语义截断（≤2160px + TRUNCATED）；S2 关键线程全部置顶、专属窗口、零 warnings。
- 本轮修正确认：S2 首跑线程未置顶（trackNames 是追加语义）→ 改为解析线程 uri 后 pinTracks 置顶，复跑达标。
