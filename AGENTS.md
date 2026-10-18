# dsh-unrestricted（ADkun fork）

DeepSeek Harness 的「破限模式」插件：一个开关，把执行规则融合进当前预设的
系统提示词（standard / ptc / cordis / minimal 及运行时可枚举的任意其他预设），
规则只约束"交付内容"，不接管调用机制；关闭即无痕回滚。
浏览器半边提供设置页一节 + 输入框内部工具栏开关，两处共用一个控制器。

**治理域身份：自有 fork。** 本仓库只从上游 `yexi-by/dsh-unrestricted` 单向同步，
不向上游提 PR、不向上游推送任何分支。原因：上游作者只接受"功能实现"方向的改动，
本 fork 侧重"使用便利性"（设置页迁移、任意预设自动适配、输入框内开关），
方向不同不构成缺陷，因此分叉维护。完整策略见 [fork 策略](docs/fork-policy.md)。

## 命令

| 目的 | 命令 | 期望结果 |
| --- | --- | --- |
| 运行单元测试 | `pnpm test` | `pass 37` / `fail 0` |
| 构建客户端产物 | `pnpm build` | 生成 `lib/client.js` 与 `lib/client.js.map`，无报错 |
| 类型检查 | `pnpm typecheck` | 仅 3 条基线报错（见下），无新增 |
| 重抓提示词夹具 | `node tools/dump-prompts.mjs --repo <DSH 源码树> --out tests/fixtures` | 重写 `tests/fixtures/*` |
| 真机验收 | `node tools/verify-live.mjs --repo <DSH 源码树>` | 全绿；需完整源码树，见「已知环境限制」 |

类型检查基线（非本次引入，`master` 上同样存在）：
`UnrestrictedCard.tsx` 的 `onChange` 回调参数隐式 `any` 与一处 `unknown` 属性访问、
`UnrestrictedDock.tsx` 的同型隐式 `any`。判定标准是**不新增**，不是清零。

## 红线

1. **只进不出**：禁止向上游开 PR、向 `origin` 推送分支或 tag（来源：用户
   2026-10-18 决定，见 [fork 策略](docs/fork-policy.md)）。`origin` 只用于 fetch。
2. **发布线不可改写**：`master` 永不 rebase、永不 force-push；同步一律走
   `sync/upstream-vX.Y.Z` 合并分支（来源：同步约定；改写会让已安装用户无法快进）。
3. **生成物不手改**：`lib/client.js` 与 `lib/client.js.map` 只由 `pnpm build`
   产出；冲突时 `git checkout --theirs` 后重建（来源：产物与源码漂移事故）。
4. **身份字段必须指向 fork**：`package.json` 的 `repository` / `homepage` / `bugs`
   每次同步后都要检查是否为 `ADkun/dsh-unrestricted`，上游合并会带回原地址。
5. **fork 独有文案逐字保留**：三份 README 的「任意其他预设 / Any Other Preset /
   その他の任意プリセット」条目在每次同步中必须保留（登记见
   [fork 策略](docs/fork-policy.md)）。
6. **每次同步必须打 tag** `vX.Y.Z-fork-sync`，否则回滚与审计失去锚点。
7. **规则只约束内容**：`src/rules.js` 的融合块不得改写工具调用、参数结构、
   沙箱机制与 PTC 程序形状（来源：规则设计红线，见 [设计](docs/design.md)）。
8. **开关默认关闭**：`cordis.patch.yml` 插入行不带 `config.enabled: true`，
   安装后不自动生效（来源：用户明确要求安装不自动改变行为）。

## Project Map

| 模块 | 一句话职责 | 规则所在 |
| --- | --- | --- |
| 宿主半边 `src/node.js` | 装配瀑布拦截、预设探测、Minimal 影子、RPC | [设计](docs/design.md) |
| 规则与提示词 `src/rules.js` | 锚点校验、融合块、契约指纹、降级 | [设计](docs/design.md) |
| 宿主服务桥 `src/host.js` | 解析宿主包，读取 `config.enabled` | [设计](docs/design.md) |
| 浏览器半边 `src/client/` | 设置页一节、输入框开关、共享控制器 | [设计](docs/design.md) |
| 打包与产物 `tsdown.config.ts` `lib/` | 客户端产物生成与导出 | 本文件「命令」 |
| 上游同步 `docs/fork-policy.md` | 单向同步、冲突裁决、版本与 tag | 该文件 |
| 合入技能 `skills/upstream-merge/SKILL.md` | 无法直并时的合入流程 | 该文件 |

## 版本文档目录

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| [design.md](docs/design.md) | 模块职责、数据对象、不变量、RPC 契约 | 改代码前 |
| [testing-guide.md](docs/testing-guide.md) | 用例总表、模式状态迁移矩阵、人工 review 项 | 改规则或改状态流前 |
| [fork-policy.md](docs/fork-policy.md) | 不 PR 原则、同步流程、冲突裁决优先级 | 每次上游发版前 |
| [prompt-fusion.md](docs/prompt-fusion.md) | 融合机制的深度说明（含 en / ja 版） | 调整融合算法时 |
| [issue-7-recovery.md](docs/issue-7-recovery.md) | 一次装配失败的排查记录 | 排查同类装配故障时 |
| [prompt-refactor-v0.1.7.md](docs/prompt-refactor-v0.1.7.md) | v0.1.7 提示词重构的背景与取舍 | 理解规则设计来源时 |

面向人的阅读顺序（非施工步骤）：`AGENTS.md` → `docs/design.md` →
`docs/testing-guide.md`；只关心同步的人读 `docs/fork-policy.md`。

## Quality Gates

| 检查项 | 载体 | 期望结果 |
| --- | --- | --- |
| 规则与契约测试 | 机检 | `pnpm test` 退出码 0，`pass 37 fail 0` |
| 类型不回归 | 机检 | `pnpm typecheck` 新增报错数 = 0（基线 3 条） |
| 产物可构建 | 机检 | `pnpm build` 退出码 0，`lib/client.js` 更新 |
| 融合不越界 | 评 | 对照 [design.md](docs/design.md) 非功能红线逐条核对 |
| 文档引用真实 | 机检 | 文中命令、路径、文档名逐个存在（见 testing-guide 引用核对项） |
| 同步后身份字段 | 机检 | `grep -c 'ADkun/dsh-unrestricted' package.json` 命中 3 处 |

## 临时工作目录

`docs-work/`（已写入 `.gitignore`，不进版本控制）：`handoff.md` 记接力状态、
`pending.md` 记待人类决策与"留待人工 review"的红线条目、工作稿与证据快照。
版本区只放最终文档，历史由 git 承载。

## 已知环境限制

- `tools/verify-live.mjs` 与 `tools/dump-prompts.mjs` 需要完整 DSH 源码树
  （`packages/boot/app-boot`、`apps/cli`、`packages/bundle/web-app` 等）；
  仅装 npm 发布包时路径布局不同，这两个工具跑不起来。
- 本机曾出现插件 `node_modules` 依赖树残缺（缺 `.bin`、缺 `@rolldown/pluginutils`），
  表现为 `pnpm build` 报 `'tsdown' is not recognized` 或
  `Cannot find package '@rolldown/pluginutils'`。修复方式是 `pnpm install --force`。
