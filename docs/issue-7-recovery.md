# Desktop 0.2.0-rc.2 的预设加载失败恢复

适用于 [issue #7](https://github.com/yexi-by/dsh-unrestricted/issues/7)：为处理插件导入错误，手工安装了 `@deepseek-ai/dsh-system-prompt`、`@deepseek-ai/dsh-scope`、`@deepseek-ai/cordis` 等宿主包，随后四个预设加载失败，并提示：

```text
persona (@deepseek-ai/dsh-persona): prompt section "deployment:persona-prefix" is already registered (for a per-agent override, register through that agent's `agent.ctx` instead)
```

这些宿主包应由桌面版运行时提供。额外安装的副本可能让预设注册与提示词服务使用不同的作用域标记，即使版本号相同也会产生该错误。

报告者同时安装的 `dsh-openwrite@0.2.12` 依赖旧版 `@deepseek-ai/schemastery@3.18.2`。默认平铺布局会把该包放在其他插件的查找路径中，破限插件随后会出现 `.volatile is not a function`。恢复流程同时改用隔离布局，保留 OpenWrite 自己的旧依赖，让破限插件继续使用宿主提供的版本。

## 恢复步骤

1. 完全退出 DeepSeek Harness Desktop，包括托盘中的进程。
2. 下载与本文一起提供的 `repair-desktop-profile.ps1`，在文件所在目录打开 PowerShell，运行：

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\repair-desktop-profile.ps1
   ```

3. 重新启动桌面版。在插件页面启用 `dsh-unrestricted`，再打开破限功能开关，确认四种模式通过校验并新建会话。

脚本先备份 profile 的配置、依赖清单和锁文件，再把包管理设置改为 `nodeLinker: isolated`、`hoist: false`、`autoInstallPeers: false`，将旧 `node_modules` 移入同一备份目录。随后使用桌面版自带 CLI 移除破限插件及直接声明的六个相关宿主包，重新安装官方 `v0.2.2` 和其余已有依赖。其他插件的依赖声明、会话和自定义预设保留；不会自动退出或启动桌面应用。备份位置会打印在命令输出中。

如果桌面版安装在其他目录，使用 `-DesktopCliPath '实际路径\resources\runtime\cli\bin\dsh.cmd'`。如果设置了不同的 DSH 数据目录，使用 `-DshHomePath '实际的 DSH_HOME 目录'`。脚本默认继承 `DSH_HOME`，未设置时使用用户目录下的 `.dsh`。

执行失败时保留完整输出并反馈。若再次出现 `ERR_MODULE_NOT_FOUND`，不要继续手工补装宿主包，应检查桌面版 CLI 路径及 profile 的安装布局。

## 实测范围

使用 Windows 上桌面版自带 `0.2.0-rc.2` 运行时及临时 profile 验证，未启动桌面界面，也未调用模型 API：

- 全新安装官方 `v0.2.2` 后，standard、ptc、cordis、minimal 均可创建 Agent。
- 开启破限后四种模式均完成注入，工具列表不变；关闭后提示词恢复。
- 按报告补装五个宿主依赖后，复现同一条全局 persona 重复注册异常。
- 保留报告中的自定义小说预设、`dsh-novel-craft@0.3.0` 和 `dsh-openwrite@0.2.12`，复现旧 schemastery 的导入冲突；隔离依赖后四种模式及小说预设重新可加载。
- 最终恢复脚本在含以上插件和手工宿主依赖的 profile 上执行后，再次完成加载、开关与回滚验证；恢复过程保持 `cordis.patch.yml` 字节不变，并保留另外两个插件的依赖声明和 bundle。

该流程针对报告中的安装状态；尚未在报告者电脑上执行。
