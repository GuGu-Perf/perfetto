# Timeline Image — 本次功能开发的全部非代码产物（唯一入口）

| 位置 | 内容 |
|---|---|
| `PLAN.md` | 设计与执行总文档（API 设计/难点/性能/测试/任务表/执行日志） |
| `tools/run-golden.mjs` + `baselines/` | 黄金场景 runner 与冻结基线（序列+像素双硬断言） |
| `tools/smoke.mjs` | 冒烟测试（6 fixture × 默认/调参） |
| `tools/scan-tracks.mjs` / `scan-tracks-deep.mjs` | 全 track 覆盖率扫描 |
| `tools/postmessage-demo.mjs` | 外部程序取图 demo |
| `tools/prune-artifacts.mjs` | 结果目录保留策略（50/30天/2GB） |
| `tools/SMOKE.md` | 冒烟结果表（最近一轮 12/12） |
| `tools/TEST-REPORT.md` | 完整测试报告（参数/期望/实际/截图路径） |
| `results/` | 全部测试结果（git 忽略；REPORT-ASSETS=代表截图，smoke/=冒烟 12 张，integration/=集成测试产物，LATEST-*=最新软链，其余=各时间戳 run） |

> 代码在源码树：`ui/src/public/timeline_image.ts`、`ui/src/core/timeline_image_manager.ts`、
> `ui/src/core_plugins/dev.perfetto.Timeline/`（离屏渲染）、`ui/src/frontend/post_message_handler.ts`。
> 协议文档增补在 `docs/visualization/embedding-api-reference.md`（上游文档树的正确位置）。
> CI 在 `.github/workflows/timeline-image-fork-ci.yml`（GitHub 要求的位置）。

日常使用：
```
node timeline-image-dev/tools/run-golden.mjs G-STD          # 黄金场景+基线验证
node timeline-image-dev/tools/smoke.mjs                      # 冒烟一轮
node timeline-image-dev/tools/prune-artifacts.mjs            # 清理旧结果
open timeline-image-dev/results/REPORT-ASSETS/               # 看截图
```
