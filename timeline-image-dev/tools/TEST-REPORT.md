# Timeline Image API — 测试报告（v9.28 现状快照）

> 本报告随重大变更重写；冒烟细节见 [SMOKE.md](SMOKE.md)；过程叙事见 [../PLAN.md](../PLAN.md) 附录 D。
> 截图目录（点击进入）：[../results/REPORT-ASSETS/](../results/REPORT-ASSETS/)

## 测试金字塔（owner 式，全部绿）

| 层 | 内容 | 最新结果 |
|---|---|---|
| 单元（vitest 全量） | 纯函数/契约（negotiateDpr、互斥、warnings 管线、adapter 解析） | 2568 通过 / 1 跳过 |
| 结构断言（Playwright） | G1 序列（trackBoxes == UI DOM title 序列）+ G2 几何（band top/height == UI DOM rects ≤1px）+ 参数/装饰/trackNames/ratio 等 8 用例 | 10/10 |
| 像素基线 | G-STD/G-DEFAULT/G-E1 冻结基线（序列+PNG hash 双硬断言，字节级确定性） | 3/3 MATCH |
| 人工标注冒烟 | 6 fixture × 默认/用户标注窗口（[SMOKE.md](SMOKE.md)），用户已确认"完全正确" | 12/12 |
| 官方全量套件 | T1.29：31 spec 功能面零回归；39 失败=像素基线环境性豁免（mac vs Linux，归因归档） | 归因闭环 |

## 关键验收数据

| 项 | 值 |
|---|---|
| 确定性 | 同输入字节级一致（GPU+SwiftShader 双后端 20/20） |
| 渲染耗时（10 track 窗口） | ~209ms（load 165/draw 22/encode 21） |
| 端到端（postMessage 宿主页取图） | ~8s（含 trace 加载） |
| native tp 加速 | 14.9MB 4.3s→0.9s（4.8x） |
| 默认输出语义 | 高度上限 2160px + TRUNCATED warning（显式 trackUris 不受限） |
| 覆盖率扫描 | 6 fixture + 1999 叶子零空白（tools/scan-tracks*.mjs） |

## 代表截图（均出自最新构建，depth 缩进对齐后）

| 图 | 说明 |
|---|---|
| [G-STD-golden.png](../results/REPORT-ASSETS/G-STD-golden.png) / [G-STD-ui-reference.png](../results/REPORT-ASSETS/G-STD-ui-reference.png) | 标准工作集 API 输出 vs 浏览器同屏参照 |
| [G-E1-golden.png](../results/REPORT-ASSETS/G-E1-golden.png) / [G-E1-ui-reference.png](../results/REPORT-ASSETS/G-E1-ui-reference.png) | 用户用例（913×685 精确 4:3）输出 vs 参照 |
| [postmessage-host-page.png](../results/REPORT-ASSETS/postmessage-host-page.png) / [postmessage-shot.png](../results/REPORT-ASSETS/postmessage-shot.png) | 外部程序宿主页取图全貌与回传 PNG |
| [smoke/](../results/REPORT-ASSETS/smoke/) | 冒烟 12 张（用户标注窗口驱动） |
| [determinism-variant-a.png](../results/REPORT-ASSETS/determinism-variant-a.png) / [-b.png](../results/REPORT-ASSETS/determinism-variant-b.png) | 确定性根因定位历史证据（修复前两收敛态） |

## 复跑命令

```sh
cd ui && node build.mjs --run-unittests            # 单元
cd ui && npx playwright test src/test/timeline_image.test.ts   # 集成（G1/G2 等）
node timeline-image-dev/tools/run-golden.mjs G-STD  # 黄金基线验证
node timeline-image-dev/tools/smoke.mjs             # 冒烟
```

## 已评估并关闭的方向

差分测试（UI 真值 vs API 像素 diff）：跨管线 oracle 适定性不足（系统性合成色差/UI 渐进加载/稀疏带相关性不适定），关闭；其守护职责由冻结基线字节 hash 与 G1/G2 结构断言承担。详见 PLAN v9.28/T1.32。
