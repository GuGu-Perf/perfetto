# 冒烟测试结果（参数经人工审核批准 · 2026-08-23 v9.24）

> 截图目录（点击文件名可看）：[results/REPORT-ASSETS/smoke/](../results/REPORT-ASSETS/smoke/)
> 命令：[smoke.mjs](smoke.mjs)（数据 [smoke.json](../results/REPORT-ASSETS/smoke/smoke.json)）
> **参数变更须先经人工审核**（PLAN D.0 审核门）。

## ⚠️ S1（零参数默认）已随 ADR-18 废除（2026-08-23 v9.38）

选择即显式：`trackUris` 必填，零参数全家福语义连同 2160px 默认上限一并删除（决策依据见 PLAN ADR-18：批量调用方不会"什么都想要"，静默截断全家福近似静默失败）。下方 S1 表仅存档历史语义，**不再执行**；2026-08-23 23:53 复跑仅含 S2，六 fixture 数值与下表 S2 逐项一致（tuned 全绿、warn 全空）。同批验证：G-STD/G-E1 golden BASELINE MATCH（G-E1 的 4:3 由两段式渲染重建，逐字节等价）。

## 复跑登记（ADR-17 参数面迁移后 · 2026-08-23 23:13 · commit eeab7412f4）

trackNames/pinTracks 删除、trackUris-only 迁移后的全量复跑。**结果与下方两表首跑逐项一致**（尺寸 / track 数 / warnings / 头部顺序全同；smoke.json 由确定性输出覆盖，数值零漂移）——S2 的"线程组按浏览器默认顺序"在新 API 下由 `trackUris: uris.concat(threadGroups)`（页内运行时发现线程组 uri）表达，无 pin 参与。配套端到端：postmessage-demo.mjs（宿主页 → iframe → PNG 真实协议链，uri-only 参数）7.3s 出图 1200×227 / 4 track / warnings 空，产物 `results/postmessage-demo/postmessage-shot.png`。结论：迁移零行为漂移，冒烟通过。

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
