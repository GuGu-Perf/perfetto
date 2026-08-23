# 人工标注表（您逐个打开 trace，标注每个的关键窗口与线程）

**用法**：点 UI 入口打开 → 拖入文件 → 按 UI 顶部显示的 timecode（相对 trace 起点，秒）找到您关心的区间 → 在"待填"两列写下起止秒数与线程名。填完我来换算成绝对时间戳并更新冒烟/差分参数。

- UI 入口（本地 dev server，启动中）：[http://127.0.0.1:10000](http://127.0.0.1:10000)
- UI 入口（官方）：[https://ui.perfetto.dev](https://ui.perfetto.dev)

| # | Trace 文件（点击获取） | 时长 | 预填线索（参考，可不采用） | 待填：窗口（UI timecode 起止，秒） | 待填：关注线程 |
|---|---|---|---|---|---|
| 1 | [example_android_trace.pftrace](../test/data/example_android_trace.pftrace) | ~9.6s | RenderThread 4543；您已标过：2.595s–2.803s（G-E1） | （已有 2.595→2.803） | （已有 RenderThread 4543） |
| 2 | [smartperfetto_android_scroll_jank_customer.pftrace](../test/data/smartperfetto_android_scroll_jank_customer.pftrace) | ~7.8s | RenderThread 13585；A2 jank 簇约 5.294–5.303s（最差帧 62.7ms） | ____→____ | ____ |
| 3 | [smartperfetto_android_scroll_standard.pftrace](../test/data/smartperfetto_android_scroll_standard.pftrace) | ~4.1s | RenderThread 7151、main 1604；最长 slice 22.8ms @ 2.474s | ____→____ | ____ |
| 4 | [smartperfetto_android_startup_heavy.pftrace](../test/data/smartperfetto_android_startup_heavy.pftrace) | ~7.2s | RenderThread 25600、main 2109；最长 slice 1.34s @ 1.644s | ____→____ | ____ |
| 5 | [smartperfetto_android_startup_light.pftrace](../test/data/smartperfetto_android_startup_light.pftrace) | ~5.3s | RenderThread 2131、main 887；最长 slice 1.05s @ 2.590s | ____→____ | ____ |
| 6 | [smartperfetto_flutter_scroll_surface_view.pftrace](../test/data/smartperfetto_flutter_scroll_surface_view.pftrace) | ~5.6s | 1.raster 10627（8483 slices）、1.ui 10626；最长 slice 1.07s @ 1.915s | ____→____ | ____ |

> 填写方式：直接编辑本文件把 `____` 替换为数值（如 `2.47→2.60`、`RenderThread 7151, main 1604`），或口头告诉我。
> 标注完成后我将：① 换算绝对 ns；② 更新 smoke 参数表（须再经您确认）；③ 实现已批的差分测试（UI 真值 vs API 同参数 diff）。
