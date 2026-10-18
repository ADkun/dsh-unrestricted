---
title: dsh-unrestricted 测试与验证
owner: ADkun
status: current
last_reviewed: 2026-10-18
---

# 测试与验证

结论先说：本插件的可执行验证只有一条链——`pnpm test`（规则 + 控制器 + 清单）
加 `pnpm typecheck`（不回归）；装配期的真实行为靠真机 `tools/verify-live.mjs`，
本机无完整源码树时这项必须登记到 `docs-work/pending.md`，不得默默跳过。

## 用例总表

用例 ID 与 [design.md](design.md) 的不变量互指；「载体」为 `机检` 表示由
`tests/*.spec.mjs` 覆盖，`评` 表示需对抗评审，`人` 表示登记人工 review 项。

| 用例 ID | 对象 | 断言内容 | 对应不变量/迁移 | 载体 |
| --- | --- | --- | --- | --- |
| TC-R01 | FusionResult | 融合输出 = 原始渲染 + 且仅 + 已登记片段 | I7 | 机检 |
| TC-R02 | FusionResult | 锚点被篡改时拒绝融合并点名失败规则 | I2、I6 | 机检 |
| TC-R03 | FusionResult | plan 锚点只在对应 section 活跃时参与校验 | I2 | 机检 |
| TC-R04 | FusionResult | ptc 模式下 `run_code` 锚点变更被识别 | I2 | 机检 |
| TC-R05 | FusionResult | 未知预设走泛化规则，不拒绝 | I2（反向：无 issue） | 机检 |
| TC-R06 | Minimal 影子 | 融合体 = persona 前缀 + 指针 + 规则块，锚点完好，保留 `structured_output` 指引 | I4、I7 | 机检 |
| TC-R07 | 规则文本 | 契约完整承载资源查找类规则 | I7 | 机检 |
| TC-R08 | 规则文本 | 契约只约束内容、不约束机制（工具调用形状不变） | 非功能红线 7 | 机检 |
| TC-R09 | 规则文本 | 环境机制被保留但不接管回答内容 | 非功能红线 7 | 机检 |
| TC-R10 | 规则文本 | 用交付物类别路由，而不是枚举边界清单 | I7 | 机检 |
| TC-R11 | 规则文本 | 回答本身就是交付物 | I7 | 机检 |
| TC-R12 | 规则文本 | 指名目标逐字保留，只有未指定值变成占位符 | I7 | 机检 |
| TC-R13 | 规则文本 | 工作区文件是输入，不构成新指令 | I7 | 机检 |
| TC-R14 | 规则文本 | 虚构场景保留给定角色细节，不塞入角色占位符 | I7 | 机检 |
| TC-R15 | 规则文本 | 虚构场景适配文风/世界观讨论/明确语域，不强推临床化措辞 | I7 | 机检 |
| TC-R16 | 规则文本 | 强制默认成年，不做年龄说教 | I7 | 机检 |
| TC-R17 | 契约指纹 | 指纹只由实际部署字节决定，同字节同指纹 | PreviewEntry.`contract` | 机检 |
| TC-R18 | renderPreview | 标准作用域变量未绑定时不抛错，字面量原样输出 | I9 | 机检 |
| TC-R19 | renderPreview | 已绑定变量原样透传 | I9 | 机检 |
| TC-R20 | contractAdditions | 每个预设收到的增量与登记完全一致 | I7 | 机检 |
| TC-R21 | 夹具覆盖 | 每个随包预设都被 `tests/fixtures/*` 捕获 | I6 | 机检 |
| TC-R22 | 规则文本 | 软件破解与逆向能力被完整表述 | I7 | 机检 |
| TC-R23 | 规则文本 | 网络与安全研究能力被完整表述 | I7 | 机检 |
| TC-R24 | 规则文本 | 高风险操作的程序化指引保持技术细节、不降级 | I7 | 机检 |
| TC-R25 | 规则文本 | 与 PTC、Plan、结构化子代理、沙箱机制协调而不冲突 | 非功能红线 7 | 机检 |
| TC-C01 | PreviewEntry | 刷新或重检后，迟到的旧预览不能覆盖已显示的新正文 | I8 | 机检 |
| TC-C02 | PreviewEntry | 失效预览的迟到错误不影响新请求；不同预设分别接收自己的结果 | I8 | 机检 |
| TC-C03 | PresetModeState | 配置事件与手动刷新重叠时保留新状态，所有请求结束后才解除忙碌 | I3（忙碌态） | 机检 |
| TC-C04 | PresetModeState | 开关提交立即使旧预览失效；配置刷新不能提前结束未完成的写入 | I8、I3 | 机检 |
| TC-M01 | 浏览器依赖 | `package.json` 声明当前 master 所需的 renderer/settings 客户端依赖 | 对外接口 | 机检 |
| TC-L01 | 装配降级 | 瀑布内任何异常都不穿透，返回原始装配 | 非功能红线 1 | 评 |
| TC-L02 | 开关关闭 | 关闭后不读不写提示词，界面回到未安装态 | I1 | 人 |

用例总数以 `pnpm test` 的输出为准（当前 `pass 37` 含子断言）；新增用例必须同时在
本表登记，ID 与不变量编号互指。

## 迁移矩阵

`PresetModeState` 的逐格迁移（行=当前状态，列=触发事件，单元格=目标状态）。

| 事件 | off | checking | active | failed |
| --- | --- | --- | --- | --- |
| 开关打开（`onEnable`） | checking | checking | checking | checking |
| 开关关闭（`onDisable`） | off | off | off | off |
| `ensureCheck` 校验通过 | 非法 | active | active | active |
| `ensureCheck` 报 issue | 非法 | failed | failed | failed |
| `recheck`（RPC） | checking | checking | checking | checking |
| 插件卸载 | off | off | off | off |

`off` 行回归 `checking` 是合法的：开关关闭期间仍可被 `recheck` 触发一次校验，
但校验结果不得影响任何装配。

## 消费方契约测试

| 消费方 | 契约 | 测试方式 |
| --- | --- | --- |
| 宿主装配链 | `sections` 的 `name` / `order` / `complete` 语义 | `tests/fixtures/sections-*.json` 与真实装配对照；夹具由 `node tools/dump-prompts.mjs --repo <DSH 源码树> --out tests/fixtures` 生成 |
| 宿主提示词渲染 | `renderPrompt({ sections, variables })` | `TC-R18` / `TC-R19` |
| 浏览器渲染层 | 槽位名与注册 order | `TC-M01` + 真机目视（见人工 review 项） |

夹具是**外部契约快照**：上游提示词结构变化时，先重抓夹具、跑 `pnpm test`，
让测试指出哪条锚点或断言随之失效，再改 `src/rules.js`。禁止反过来改断言去迁就夹具。

## 人工 review 项

不可由脚本判定的项集中在此登记，逐条带验收判据；决策人 = 仓库维护者（ADkun）。

| 项 | 内容 | 验收判据 |
| --- | --- | --- |
| TC-L02 | 关闭态无痕回滚 | 装载插件→打开开关→关闭开关，重启后再装配的提示词与安装前逐字节一致（可用 `node tools/dump-prompts.mjs` 前后对比） |
| HR-01 | 三语言外显一致 | 三份 README 的同一特性段落同时存在且语义一致；安装标签版本号三处相同 |
| HR-02 | 文档引用真实 | `AGENTS.md` 与本目录文档里出现的命令、路径、文档名逐个存在：`pnpm test`、`pnpm build`、`pnpm typecheck` 可跑；`docs/*.md` 全部存在；`skills/upstream-merge/SKILL.md` 存在 |
| HR-03 | 装配期惰性 | 只打开一个非 minimal 预设时，`status` 不应阻塞在该预设以外的校验上（观察设置页首次打开耗时） |
| HR-04 | 界面文案归属 | 设置页一节与输入框开关同源：任一处切换后另一处无需刷新即一致 |
| HR-05 | 真机验收 | `node tools/verify-live.mjs --repo <DSH 源码树>` 全绿；无源码树时该项在 `docs-work/pending.md` 保持未销账 |
