# Timeline Image — 本次功能开发的全部非代码产物（唯一入口）

| 内容 | 链接 |
|---|---|
| 设计与执行总文档（API 设计/难点/性能/测试/任务表/执行日志） | [PLAN.md](PLAN.md) |
| 冒烟结果表（S2 六 fixture 通过；S1 零参数已随 ADR-18 废除） | [tools/SMOKE.md](tools/SMOKE.md) |
| 测试报告（金字塔现状+关键数据+代表截图） | [tools/TEST-REPORT.md](tools/TEST-REPORT.md) |
| 黄金场景 runner | [tools/run-golden.mjs](tools/run-golden.mjs) |
| 冻结基线（序列+像素双硬断言） | [tools/baselines/](tools/baselines/) |
| 冒烟测试脚本 | [tools/smoke.mjs](tools/smoke.mjs) |
| 全 track 覆盖率扫描 | [tools/scan-tracks.mjs](tools/scan-tracks.mjs) / [scan-tracks-deep.mjs](tools/scan-tracks-deep.mjs) |
| 外部程序取图 demo | [tools/postmessage-demo.mjs](tools/postmessage-demo.mjs) |
| 结果目录保留策略清理 | [tools/prune-artifacts.mjs](tools/prune-artifacts.mjs) |
| 代表性截图（G-STD/G-E1/postMessage/确定性/冒烟 12 张） | [results/REPORT-ASSETS/](results/REPORT-ASSETS/) |
| 冒烟截图目录 | [results/REPORT-ASSETS/smoke/](results/REPORT-ASSETS/smoke/) |
| 集成测试产物 | [results/integration/](results/integration/) |
| 全部历史 run 目录 | [results/](results/) |

**代码位置**（源码树，随上游结构）：
- 公共 API：[ui/src/public/timeline_image.ts](../ui/src/public/timeline_image.ts)
- 管理器：[ui/src/core/timeline_image_manager.ts](../ui/src/core/timeline_image_manager.ts)
- 离屏渲染器：[ui/src/core_plugins/dev.perfetto.Timeline/offscreen_timeline_renderer.ts](../ui/src/core_plugins/dev.perfetto.Timeline/offscreen_timeline_renderer.ts)
- postMessage 入口：[ui/src/frontend/post_message_handler.ts](../ui/src/frontend/post_message_handler.ts)
- 集成测试：[ui/src/test/timeline_image.test.ts](../ui/src/test/timeline_image.test.ts)
- 协议文档（上游文档树位置）：[docs/visualization/embedding-api-reference.md](../docs/visualization/embedding-api-reference.md)
- CI workflow（GitHub 要求位置）：[.github/workflows/timeline-image-fork-ci.yml](../.github/workflows/timeline-image-fork-ci.yml)

日常使用：
```sh
node timeline-image-dev/tools/run-golden.mjs G-STD   # 黄金场景+基线验证（冻结集：G-STD / G-E1）
node timeline-image-dev/tools/smoke.mjs              # 冒烟一轮（六 fixture，tuned 场景）
node timeline-image-dev/tools/prune-artifacts.mjs    # 清理旧结果
open timeline-image-dev/results/REPORT-ASSETS/       # 看截图
```

**API 终版速览（ADR-18，2026-08-24 冻结）**：`renderTimelineImage({trackUris 必填, timeSpan?=全 trace, widthPx?=1920, heightPx?, devicePixelRatio?=2, format?=png})`；选择即显式（列表顺序=渲染顺序，组 uri 展开 leaf，未知 uri reject）；发现用 `listTracks` 消息。参数面/入口收敛的完整决策链见 PLAN.md ADR-14~19。
