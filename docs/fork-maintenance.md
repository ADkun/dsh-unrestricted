# 版本线说明（fork-only，勿提交上游）

## 当前拓扑

master 是**发布线**，只合上游发布，永不 rebase；
分支 `feat/settings-section-any-preset` 是本 fork 的自有特性线
（设置页迁移 + 任意预设自动适配 + 输入框内部工具栏开关）。

```
e884f74 v0.2.3 (上游)                    16ecbe7, 2d6922b 文档微调
      \                                      /
       \--------- (fork 发布线) -------------/
                                                 \
7beb2d2 v0.2.4 (上游) ---> sync/upstream-v0.2.4 -> master (tag v0.2.4-fork-sync)
                                          \
93b6e08 + b2110ad (fork 特性) -> feat/settings-section-any-preset
```

## 同步规则（与用户约定）

1. **只进不出**：只从 origin（上游）同步发布到本 fork，不反向 PR。
2. **sync 分支**：每次同步从 master 切 `sync/upstream-vX.Y.Z`，
   `git merge --no-ff --no-edit origin/master`，sync 分支**只含上游内容**，
   不带 fork 特性。
3. **冲突语义化处理**：
   - README 三语言：保留上游的段落，**保留 fork 的「任意其他预设」段落并标记**
     （本文件中「fork-only 段落登记」一节逐条列出，未来合并必须逐字保留）。
   - `package.json` 的 `repository`/`homepage`/`bugs`：**每次合并后都要改回
     ADkun 地址**（上游合并会带回 yexi-by），版本号暂时跟随上游，fork 特性
     并入 master 时 bump 到 0.3.0。
   - `lib/client.js` / `lib/client.js.map`：生成产物，冲突时
     `git checkout --theirs` 后 `pnpm build` 重新生成，禁止手改。
4. **验证链**：`pnpm typecheck`（3 个历史遗留 any 报错属基线，不回归即可）
   → `pnpm build` → `pnpm test`（37 passed）→ `tools/verify-live.mjs`
   （本机没有 DSH 源码树，用 rc.2 的发布包无法复现 verify-live 需要的
   `--repo` 相对路径布局，**本轮未跑**；真实验收改为安装进
   `C:\Users\adkun\.dsh` 的 web profile）。
5. **合回 master**：`git checkout master && git merge --no-ff sync/...`，
   打 tag（如 `v0.2.4-fork-sync`）。

## fork-only 段落登记（未来同步必须保留）

README.md / README.en.md / README.ja.md 的「多模式深度适配 / 多模式」小节内，
在**极简模式（Minimal）**条目之后有一条本 fork 独有 bullet，中文原文：

> **任意其他预设（用户自建及后续新增）**：预设清单在运行时通过
> `agentPresets.list()` 动态枚举……设置面板会自动多出一行。

en：`Any Other Preset (user-authored and future additions)`；
ja：`その他の任意プリセット（ユーザー自作および今後の追加分）`。

上游 v0.2.4 改写了 Minimal 条目（在 agent scope 注入、保留自定义角色正文），
本轮冲突的解法是：**Minimal 用上游措辞 + fork-only bullet 原样接在后面**。
后续任何同步沿用同一解法。

## 已知环境限制（本机）

- `tools/verify-live.mjs --repo` 需要完整 DSH 源码树（packages/boot/app-boot、
  apps/cli、packages/bundle/web-app 等）；本机只有 npm 发布包
  （`C:\Users\adkun\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\*`，
  版本 0.2.0-rc.2），路径布局不同，直接跑 verify-live 不可行。
- 为跑 typecheck 已把 14 个宿主包从该 npx 缓存拷进
  `plugins/dsh-unrestricted/node_modules/@deepseek-ai/`（仅本地，不入库）。
