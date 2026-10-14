#requires -Version 5.1
<#
.SYNOPSIS
修复 issue #7 中手工补装宿主依赖后，桌面版预设全部加载失败的问题。
.DESCRIPTION
先备份 profile 配置和依赖清单，再通过桌面版自带 CLI 隔离第三方依赖，
移除手工宿主依赖，并重新安装已验证的官方插件 v0.2.2。
运行前请完全退出 DSH Desktop；脚本不会退出或启动桌面应用。
#>
[CmdletBinding()]
param(
    [string]$DesktopCliPath = (Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),
    [string]$DshHomePath = $(if ([string]::IsNullOrWhiteSpace($env:DSH_HOME)) { Join-Path $env:USERPROFILE '.dsh' } else { $env:DSH_HOME }),
    [string]$ProfileName = 'desktop'
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $DesktopCliPath -PathType Leaf)) {
    throw "找不到桌面版 CLI：$DesktopCliPath。请用 -DesktopCliPath 指定实际安装目录内的 dsh.cmd。"
}
if ($ProfileName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]*$') {
    throw 'ProfileName 必须是 profile 名称，不能是路径。'
}
$DshHomePath = [System.IO.Path]::GetFullPath($DshHomePath)
$profileDirectory = Join-Path (Join-Path $DshHomePath 'profiles') $ProfileName
$manifestPath = Join-Path $profileDirectory 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "找不到现有 profile：$manifestPath。请确认 DSH_HOME 或用 -DshHomePath 指定实际目录。"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sharedPackageNames = @(
    '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-scope',
    '@deepseek-ai/dsh-invariants',
    '@deepseek-ai/dsh-llm'
)
$declaredNames = @(
    foreach ($section in @('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies')) {
        $dependencies = $manifest.$section
        if ($null -ne $dependencies) { $dependencies.PSObject.Properties.Name }
    }
)
$removeNames = @(
    @('dsh-unrestricted') + $sharedPackageNames |
        Where-Object { $declaredNames -contains $_ } |
        Select-Object -Unique
)
$backupDirectory = Join-Path $profileDirectory ('.plugin-manager/backups/unrestricted-issue7-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
foreach ($filename in @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.yml', 'cordis.patch.yml')) {
    $sourcePath = Join-Path $profileDirectory $filename
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $backupDirectory $filename)
    }
}
Write-Host "配置和依赖清单已备份到：$backupDirectory"

function Invoke-DesktopDsh {
    param([string[]]$DshArguments)
    & $DesktopCliPath @DshArguments
    if ($LASTEXITCODE -ne 0) {
        throw "桌面版 CLI 执行失败（退出码 $LASTEXITCODE）。请保留上面的错误和备份目录；不要手工安装 @deepseek-ai 宿主包。"
    }
}

$previousDshHome = $env:DSH_HOME
try {
    $env:DSH_HOME = $DshHomePath
    Invoke-DesktopDsh -DshArguments @('--version')
    # OpenWrite 的旧 schemastery 仅供它自身使用，不能提升到其他插件的查找路径。
    Invoke-DesktopDsh -DshArguments @('plugin', '--profile', $ProfileName, 'config', 'set', 'nodeLinker', 'isolated', '--location', 'project')
    Invoke-DesktopDsh -DshArguments @('plugin', '--profile', $ProfileName, 'config', 'set', 'hoist', 'false', '--location', 'project')
    Invoke-DesktopDsh -DshArguments @('plugin', '--profile', $ProfileName, 'config', 'set', 'autoInstallPeers', 'false', '--location', 'project')

    # 更换安装布局前保留旧目录；不删除插件源码、会话或 profile 配置。
    $moduleDirectory = [System.IO.Path]::GetFullPath((Join-Path $profileDirectory 'node_modules'))
    $moduleBackup = [System.IO.Path]::GetFullPath((Join-Path $backupDirectory 'node_modules'))
    $profilePrefix = [System.IO.Path]::GetFullPath($profileDirectory).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if (-not $moduleDirectory.StartsWith($profilePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $moduleBackup.StartsWith($profilePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '依赖目录或备份目录不在指定 profile 内，已停止。'
    }
    if (Test-Path -LiteralPath $moduleDirectory) {
        Move-Item -LiteralPath $moduleDirectory -Destination $moduleBackup
    }
    if ($removeNames.Count -gt 0) {
        Invoke-DesktopDsh -DshArguments (@('plugin', '--profile', $ProfileName, 'remove') + $removeNames)
    }
    Invoke-DesktopDsh -DshArguments @('plugin', '--profile', $ProfileName, 'add', 'github:yexi-by/dsh-unrestricted#v0.2.2')
    $installedManifestPath = Join-Path $profileDirectory 'node_modules/dsh-unrestricted/package.json'
    $installed = Get-Content -LiteralPath $installedManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installed.version -ne '0.2.2') {
        throw "安装包版本应为 0.2.2，实际为 $($installed.version)。请保留命令输出。"
    }
    Write-Host '官方 dsh-unrestricted v0.2.2 已重新安装，第三方依赖已隔离。请启动 DSH Desktop，开启插件及破限功能开关，再新建会话验证。'
} finally {
    $env:DSH_HOME = $previousDshHome
}
