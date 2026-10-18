---
title: dsh-unrestricted fork 维护策略
owner: ADkun
status: current
last_reviewed: 2026-10-18
---

# fork 维护策略

## 原则

结论：本仓库是**只维护自有 fork**的仓库——只从上游单向拉取，不向上游提交任何东西。

三条推论，逐条都要能解释：

1. **不向上游提 PR、不向上游推送分支与 tag。** 上游是 `yexi-by/dsh-unrestricted`，
   在本仓库里只以 `origin` 存在，且只用于 `git fetch`。曾经设想过反向 PR，
   已明确放弃。
2. **分叉的原因不是体量，是方向。** 上游作者只接受「功能实现」方向的改动；
   本 fork 侧重「使用便利性」——设置页迁移成一节、任意预设自动适配、
   开关放进输入框内部工具栏。方向不同不构成缺陷，因此并存而不是合并。
3. **自有发布线独立演进。** 版本号、tag、README 的安装标签都指向
   `ADkun/dsh-unrestricted`；README 里的作者署名与许可证保持不变（MIT 与上游一致）。

违反第 1 条的后果是真实的：一旦向上游推了分支，两个仓库的分歧会变成公开的分叉
讨论，"只维护自己那份"的前提就没了。因此这条写进
[AGENTS.md](../AGENTS.md) 的红线，本文件只解释它。

## 分支模型

| 分支 | 角色 | 规则 |
| --- | --- | --- |
| `origin/master`（上游） | 只读来源 | 禁止推送；同步时只 `fetch` 后合并 |
| `master`（本仓库发布线） | 用户安装的就是它 | 禁止 rebase、禁止 force-push；只接受 `--no-ff` 合并进入 |
| `sync/upstream-vX.Y.Z` | 一次性同步分支 | 只含上游内容，不带 fork 自有功能；合并完即打 tag |
| `feat/<主题>` | 单主题功能线 | 一个主题一条；合入 `master` 用 `--no-ff`；发布后再快进或删除 |

`master` 的上游跟踪必须指向 **`fork/master`**（本仓库自己的远端），不是
`origin/master`。这一点每次重装或重建克隆后都要核对一次：跟踪错误会让
"顺手 push"直接落到上游地址上。

## 上游发布新版本时

完整流程见 [合入技能](../skills/upstream-merge/SKILL.md)；本文件只定裁决规则，
不重复步骤。

裁决只按"这段代码归谁"判断，不按"哪个版本更新"判断：

| 冲突位置 | 裁决 | 理由 |
| --- | --- | --- |
| 融合逻辑、锚点、装配瀑布（上游的领域） | 上游赢 | 上游在修的是宿主契约适配，本 fork 无独立实现 |
| 设置页 / 输入框开关 / 任意预设适配（fork 的领域） | fork 赢 | 上游从未实现，删掉即功能消失 |
| `lib/client.js`、`lib/client.js.map` | 谁都不赢，只重建 | 生成物；`git checkout --theirs` 后 `pnpm build` |
| `package.json` 的 `repository` / `homepage` / `bugs` | fork 赢 | 上游合并会带回原地址；安装标签必须指向本仓库 |
| `engines.dsh`、`dsh.client` 依赖清单 | 上游赢 | 它描述宿主版本能力，不是 fork 偏好 |
| README 正文 | 上游赢；fork 段落在上游段之后原样保留 | 见下节登记表 |
| `cordis.patch.yml` | 取并集 | 两边都是"插入一行"，语义不冲突 |

不确定归属时停下来问维护者，不要用"看起来能跑"来裁定——语义错的合并能通过
所有测试。

## fork 独有段落登记（同步时必须逐字保留）

三份 README 的「多模式深度适配 / 多模式」小节里，紧跟「极简模式（Minimal）」
条目之后有一条本 fork 独有条目：

| 文件 | 条目标题原文 |
| --- | --- |
| `README.md` | `任意其他预设（用户自建及后续新增）` |
| `README.en.md` | `Any Other Preset (user-authored and future additions)` |
| `README.ja.md` | `その他の任意プリセット（ユーザー自作および今後の追加分）` |

内容要点：预设清单在运行时通过 `agentPresets.list()` 动态枚举，因此用户自建的、
上游后续新增的预设都会自动出现在设置面板里，无需为新预设改代码。

上游在 v0.2.4 曾改写 Minimal 条目（改为 agent 作用域注入、保留自定义角色正文）。
那次冲突的解法是标准的：**Minimal 用上游措辞，fork-only 条目原样接在其后**。
后续任何同步沿用同一解法；不要为了"减少 diff"删掉 fork 条目。

## 版本与 tag

- **版本号**表示"本 fork 发布的第几个版本"，不是上游版本号的副本。
  只同步、不含新功能 → patch +1；同步之外还合入了 fork 功能 → minor +1。
- **每次同步必须打 tag** `vX.Y.Z-fork-sync`，指向合并提交；它是对账锚点，
  也是 `git revert -m 1 <tag>` 回滚的起点。
- **发布 tag** `vX.Y.Z` 打在 `master` 上，README 三语言的安装命令引用它。
  改 `package.json` 的 `version` 与三份 README 的安装标签必须同一次提交完成。
- 已发布 tag 永不移动。发现错误就发新版本，或者用新提交回滚。

## 硬规矩

1. 发布线永不 rebase、永不 force-push（依据：已安装用户只做快进）。
2. 一个同步分支只做一次同步；不要在同一条分支上连着合两个上游版本。
3. 生成物不手改；冲突一律重建。
4. 同步后立刻核对 `package.json` 的三个身份字段。
5. 合并前先 `git merge-tree` 预演冲突，不要拿工作树当试错场。
6. 同步后跑完整验证链（见 [AGENTS.md](../AGENTS.md) 的 Quality Gates），
   真机验收跑不了就在 `docs-work/pending.md` 登记，不要当成通过。

## 相关文件

- 合入操作步骤：[skills/upstream-merge/SKILL.md](../skills/upstream-merge/SKILL.md)
- 模块设计：[docs/design.md](design.md)
- 环境限制（无完整源码树时哪些工具跑不起来）：[AGENTS.md](../AGENTS.md)
