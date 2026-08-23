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

## S2 关键区间组（**2026-08-23 用户人工标注**，经 trace_processor 交叉验证：slice ID ↔ timecode ↔ 线程精确一致）

| Fixture | 关键线程（置顶） | 窗口依据（用户标注的 slice 锚点） | 尺寸 | track | warnings | 截图 |
|---|---|---|---|---|---|---|
| example | RenderThread 4543 | 用户用例 G-E1（slice[95635..115701]） | 1600×685 | 20 | 无 | [example-tuned.png](../results/REPORT-ASSETS/smoke/example-tuned.png) |
| jank_customer | rcustomscroller 13534 | slice[10372 doFrame]→slice[12343 doFrame] | 1600×719 | 16 | 无 | [jank_customer-tuned.png](../results/REPORT-ASSETS/smoke/jank_customer-tuned.png) |
| scroll_standard | rcustomscroller 12887 | slice[497 ACTION_DOWN]→slice[4875 doFrame] | 1600×666 | 18 | 无 | [scroll_standard-tuned.png](../results/REPORT-ASSETS/smoke/scroll_standard-tuned.png) |
| startup_heavy | unch.aosp.heavy 21307 | slice[5937 MountEmulatedStorage]→slice[138099 MQ_Chain] | 1600×736 | 19 | 无 | [startup_heavy-tuned.png](../results/REPORT-ASSETS/smoke/startup_heavy-tuned.png) |
| startup_light | .androidappdemo 8111 | slice[5597 MountEmulatedStorage]→slice[44997 doFrame] | 1600×826 | 19 | 无 | [startup_light-tuned.png](../results/REPORT-ASSETS/smoke/startup_light-tuned.png) |
| flutter_scroll | 1.ui 10626 + 1.raster 10627 | slice[1364 requestNextVsync]→slice[6201 CALLBACK_ANIMATION] | 1600×672 | 20 | 无 | [flutter_scroll-tuned.png](../results/REPORT-ASSETS/smoke/flutter_scroll-tuned.png) |

公共参数：全部 CPU 的 freq+sched（运行时收集）+ 用户标注线程组（**按浏览器默认顺序，不 pin**：freq→sched→…→线程）+ `widthPx: 1600`；行分隔线全宽（含内容区，对齐 UI `__shell`/`__canvas` 的 border-bottom，颜色 border-secondary）。
标注原文见 [../ANNOTATIONS.md](../ANNOTATIONS.md)。

## 结论
- **12/12 通过**：S1 全部按默认语义截断；S2 全部为用户人工标注窗口，浏览器默认顺序、零 warnings；用户人工 review 确认截图正确（v9.25 前的 tuned 批次），本轮仅样式补齐（行线全宽）与去 pin。
