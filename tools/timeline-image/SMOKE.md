# 冒烟测试结果（一轮，最终版本 v9.22）

> 截图：`out/test-runs/REPORT-ASSETS/smoke/<fixture>-<组名>.png`（12 张全部可打开）
> 命令：`node tools/timeline-image/smoke.mjs`（数据 smoke.json 同目录）

## S1 默认参数 `renderTimelineImage({widthPx: 1200, devicePixelRatio: 1})`
含义：不挑 track、不挑窗口 = 浏览器默认全部可见 track。期望：完整出图、零 warnings、有内容。

| Fixture | 实际尺寸 | track 数 | 耗时 | warnings | 截图 |
|---|---|---|---|---|---|
| example_android_trace | 1200×4768 | 134 | 1074ms | [] | smoke/example_android_trace-default.png |
| scroll_jank_customer | 1200×6579 | 174 | 715ms | [] | smoke/smartperfetto_android_scroll_jank_customer-default.png |
| scroll_standard | 1200×4584 | 124 | 541ms | [] | smoke/smartperfetto_android_scroll_standard-default.png |
| startup_heavy | 1200×6640 | 177 | 740ms | [] | smoke/smartperfetto_android_startup_heavy-default.png |
| startup_light | 1200×4138 | 115 | 520ms | [] | smoke/smartperfetto_android_startup_light-default.png |
| flutter_scroll_surface_view | 1200×4784 | 129 | 786ms | [] | smoke/smartperfetto_flutter_scroll_surface_view-default.png |

## S2 常用调整（挑 track + 窗口 + 宽高比）
```ts
renderTimelineImage({
  trackUris: ['/cpu_freq_cpu0..3', '/sched_cpu0..3'],
  timeSpan: {start: <trace中段>, end: <中段+1s>},
  aspectRatio: 4/3, devicePixelRatio: 1,
})
```
含义：用户截窗口的典型用法。期望：宽=round(高×4/3)、零 warnings、有内容。

| Fixture | 实际尺寸 | 比例 | track 数 | 耗时 | warnings | 截图 |
|---|---|---|---|---|---|---|
| example_android_trace | 323×242 | 1.335 | 8 | 178ms | [] | smoke/example_android_trace-tuned.png |
| scroll_jank_customer | 323×242 | 1.335 | 8 | 142ms | [] | smoke/..._customer-tuned.png |
| scroll_standard | 323×242 | 1.335 | 8 | 119ms | [] | smoke/..._standard-tuned.png |
| startup_heavy | 323×242 | 1.335 | 8 | 139ms | [] | smoke/..._heavy-tuned.png |
| startup_light | 323×242 | 1.335 | 8 | 101ms | [] | smoke/..._light-tuned.png |
| flutter_scroll_surface_view | 323×242 | 1.335 | 8 | 175ms | [] | smoke/..._surface_view-tuned.png |

## 结论
- **12/12 通过**：两组参数在全部 6 份 trace 上零 warnings 出图，比例/尺寸/耗时符合期望。
- 冒烟附带发现（已立账 T1.30）：默认全量 track（6000+px 高）+ aspectRatio 组合会算出超护栏宽度被正确拒绝——行为正确，但错误信息应引导用户缩窄 track 集或改用 widthPx。
