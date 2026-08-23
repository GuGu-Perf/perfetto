# Timeline Image API — 本地测试用例与结果报告

> 快照日期：2026-08-23（v9.22 代码状态）。所有结果可复跑：各节附命令。
> 分支：pr1-timeline-image。测试数据：`test/data/`（本地 demo traces）。

## 0. 测试资产

| Fixture | 大小 | 用途 |
|---|---|---|
| smartperfetto_android_scroll_jank_customer.pftrace | 14.9MB | 主 fixture：jank 窗口 A1/A2/A3、黄金场景 G-STD/G-DEFAULT、全量扫描 |
| smartperfetto_android_scroll_standard.pftrace | 6.5MB | 扫描矩阵（滚动标准场景） |
| smartperfetto_android_startup_heavy.pftrace | 27MB | 扫描矩阵（重启动） |
| smartperfetto_android_startup_light.pftrace | 3.6MB | 扫描矩阵（轻启动） |
| smartperfetto_flutter_scroll_surface_view.pftrace | 5.6MB | 扫描矩阵（Flutter） |
| example_android_trace.pftrace | 58MB | 官方 Apache 数据：用户用例 G-E1、9-CPU 验证 |

> ⚠️ smartperfetto 五份为 AGPL 授权，仅本地使用（.git/info/exclude 排除），不进仓库/CI。

## 1. 单元测试（2568 通过 / 1 跳过）

范围：全仓 vitest 套件（含我们新增 10 个：negotiateDpr 两分支、互斥校验、
aspectRatio≤0、d2 上下文、超限拒绝、manager 3 例等）。
复跑：`cd ui && node build.mjs --run-unittests`

## 2. Playwright 集成测试（9/9 通过）— `ui/src/test/timeline_image.test.ts`

| 用例 | 意图 | 结果 |
|---|---|---|
| A2 jank cluster | pin 置顶、堆叠布局、非纯色（多色采样） | ✅ |
| 字节确定性 | 同参数两次渲染 blob 逐字节一致 | ✅ |
| A1 边界 | 窗口左缘内容存在（关装饰纯内容画布） | ✅ |
| A3 宽窗 | 全手势窗口渲染 | ✅ |
| G1 顺序 | 默认输出 title 序列 == UI DOM 序列（顺序自动断言） | ✅ |
| C1 装饰 | 默认 shell+时间轴：高度差 22px、名称列/轴行有像素、depth 传递 | ✅ |
| T1.27/T1.28 | trackNames 按名解析 + width==round(height×4/3) | ✅ |
| T1.27 未匹配 | TRACK_MISSING warning + 显式 uri 照常渲染 | ✅ |

复跑：`cd ui && npx playwright test src/test/timeline_image.test.ts`

## 3. 黄金场景与冻结基线（3/3 MATCH，序列+像素 hash 双硬断言）

`tools/timeline-image/run-golden.mjs`；基线 `tools/timeline-image/baselines/*.json`（入 git）。

| 场景 | 参数要点 | 最新结果 |
|---|---|---|
| G-STD（标准工作集） | RenderThread pin 置顶 + cpu0-3 freq/sched + A2 窗，1800@dpr1 | 1800×392，10 track，0 warnings，MATCH ✓ |
| G-DEFAULT（零参数语义） | 不传 trackUris/时间窗 = UI 默认全部可见行 | 1800×6579，174 track，MATCH ✓ |
| G-E1（用户亲写用例） | example trace，slice[95635..115701] 窗，RenderThread 4543 pin，4:3 | 913×685（精确 4:3），20 track，MATCH ✓ |

## 4. 全 track 覆盖率扫描（T1.15，零空白）

`tools/timeline-image/scan-tracks.mjs` / `scan-tracks-deep.mjs`；产物 `out/test-runs/2026-08-23-04-23-23-t1.15-scan/`。

- 第一层：6 fixture 默认视图 —— 全部零空白、noWarmup=0（warm-up 覆盖 100%）
- 第二层：jank fixture 全部 1999 叶子分批渲染 —— 零空白；低覆盖 287 条抽查均为稀疏数据源（battery_stats/clock snapshots 等）正常表现

## 5. 确定性实验（T1.14 收口证据）

产物 `out/test-runs/t1.14-rootcause/`。

| 实验 | 结果 |
|---|---|
| GPU 连渲 20 次（修复后） | 1 个 hash（20/20 字节全等） |
| SwiftShader 连渲 20 次 | 1 个 hash（双后端字节全等） |
| 根因 | fixed-point maxRounds=3 截断（非 MSAA），修复后收敛完整 |

## 6. postMessage 端到端（M2 demo）

`tools/timeline-image/postmessage-demo.mjs`；产物 `out/test-runs/postmessage-demo/`。
宿主页 iframe 嵌入 → PING/PONG → post trace+请求（背靠背，挂起至就绪）→ PNG 回传。
结果：~8s 端到端（含 daemon 重启），零 warnings，4 track，两连跑稳定。

## 7. 全量官方套件回归（T1.29）

产物 `out/test-runs/2026-08-23T05-30-t1.29-full-regression/`。

| 层 | 结果 |
|---|---|
| prettier/eslint | 修复 6 文件后 rc 双 0 |
| 干净全量 31 spec | 13 过（含 timeline_image 9/9）；39 失败 = 100% 像素基线 diff（环境性豁免：mac vs Linux 官方基线，三重证据）；40 链式跳过 |

## 8. 性能实测

| 指标 | 值 |
|---|---|
| 渲染 API 耗时（10 track 窗口图） | ~209ms（load 165/draw 22/encode 21） |
| 端到端（含浏览器+trace 加载，native tp） | ~5s |
| native tp 加载提速（14.9MB） | 4.3s → 0.9s（~4.8x） |
| example 58MB 加载 | 2.6s（WASM 3.3s） |
