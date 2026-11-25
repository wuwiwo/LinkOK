# LinkOK 环境引导（所有构建脚本都 dot-source 这个文件）
# 用法： . "$PSScriptRoot\env.ps1"

$ErrorActionPreference = 'Stop'

# ── 工作区根 ────────────────────────────────────────────────
$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

# ── Android / JVM 工具链 ────────────────────────────────────
# 复用机器上已有的自包含工具链，不重复下载。
#
# 优先级：
#   1. 环境变量 LINKOK_TOOLCHAIN 指定的目录
#   2. 本机已安装的常见位置（下面的 candidates）
# 目录内期望有 jdk-17\、android-sdk\、gradle-8.7\ 三件套。
#
# 没有工具链也能跑 Hub（Node 部分），只有构建 APK 时才需要它。
$script:Toolchain = $env:LINKOK_TOOLCHAIN
if (-not $Toolchain) {
    $candidates = @(
        (Join-Path $Root '.toolchain')
    ) + @(
        "$env:USERPROFILE\.linkok-toolchain"
    ) | Where-Object { $_ -and (Test-Path (Join-Path $_ 'jdk-17')) }
    if ($candidates.Count -gt 0) { $script:Toolchain = $candidates[0] }
}

if ($Toolchain -and (Test-Path (Join-Path $Toolchain 'jdk-17'))) {
    $env:JAVA_HOME    = Join-Path $Toolchain 'jdk-17'
    $env:ANDROID_HOME = Join-Path $Toolchain 'android-sdk'
    $env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
    $script:Gradle = Join-Path $Toolchain 'gradle-8.7\bin\gradle.bat'
    $script:Java   = Join-Path $env:JAVA_HOME 'bin\java.exe'
} else {
    Write-Host '[warn] 未找到 Android 工具链（jdk-17 / android-sdk / gradle-8.7）' -ForegroundColor Yellow
    Write-Host '       设置 LINKOK_TOOLCHAIN 指向工具链目录，或把工具链放到 .toolchain\' -ForegroundColor Yellow
    Write-Host '       只运行 Hub 的话可以忽略这个警告。' -ForegroundColor Yellow
    $script:Gradle = $null
    $script:Java   = $null
}

# ⚠ 关键：LinkOK 必须有【自己的】Gradle 缓存。
# 共享其他工程的 gradle-home 会因 native-platform.dll 损坏而启动失败（已实测）。
$env:GRADLE_USER_HOME = Join-Path $Root '.gradle-home'

# ── Node / npm ──────────────────────────────────────────────
# ⚠ 沙箱只允许写工作区。默认 npm 缓存在 %LOCALAPPDATA% 会被拒绝（EPERM），
#    所以缓存必须重定向到工程内。
$env:npm_config_cache    = Join-Path $Root '.npm-cache'
$env:npm_config_registry = 'https://registry.npmjs.org/'
$env:npm_config_fund     = 'false'
$env:npm_config_audit    = 'false'

# ── .NET Framework（C# helper 用系统自带编译器）──────────────
$script:Csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$script:FrameworkDir = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

# ── adb ─────────────────────────────────────────────────────
# 按顺序找：环境变量 → PATH → Android SDK 自带 → 常见独立安装位置
$script:Adb = $env:LINKOK_ADB
if (-not $Adb -or -not (Test-Path $Adb)) {
    $adbCandidates = @(
        (Get-Command adb.exe -ErrorAction SilentlyContinue).Source
    )
    if ($env:ANDROID_HOME) { $adbCandidates += (Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe') }
    $adbCandidates += @(
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        'C:\platform-tools\adb.exe'
    )
    $script:Adb = $adbCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $Adb) {
        Write-Host '[warn] 未找到 adb（只在安装 APK 到手机时需要）' -ForegroundColor Yellow
    }
}

# ── 便利函数 ────────────────────────────────────────────────

# 沙箱禁止程序经由管道捕获 stdio（EPERM on named pipe）。
# 因此所有外部命令都用 Start-Process + 文件重定向。
function Invoke-Captured {
    param(
        [Parameter(Mandatory)] [string] $FilePath,
        [string[]] $ArgumentList = @(),
        [string] $WorkingDirectory = $Root
    )
    $out = Join-Path $env:TEMP ("lk-out-{0}.txt" -f [guid]::NewGuid())
    $err = Join-Path $env:TEMP ("lk-err-{0}.txt" -f [guid]::NewGuid())
    try {
        $p = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
             -WorkingDirectory $WorkingDirectory -NoNewWindow -Wait -PassThru `
             -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{
            ExitCode = $p.ExitCode
            StdOut   = if (Test-Path $out) { Get-Content $out -Raw } else { '' }
            StdErr   = if (Test-Path $err) { Get-Content $err -Raw } else { '' }
        }
    } finally {
        Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-Gradle {
    param([string[]] $ArgumentList, [string] $WorkingDirectory = (Join-Path $Root 'android'))
    Invoke-Captured -FilePath $Gradle -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory
}

# 编译 C# helper。引用路径含空格，/reference: 参数必须带引号，
# 否则 csc 会拆开路径并报 CS2005（已踩过）。
function Build-Helper {
    param([string] $SourceDir = (Join-Path $Root 'pc\helper'))
    $cs = Get-ChildItem $SourceDir -Filter *.cs -Recurse | ForEach-Object { $_.FullName }
    $args = @('/nologo', '/target:winexe', '/optimize+',
              ('/out:"{0}"' -f (Join-Path $SourceDir 'linkok-helper.exe')),
              ('/reference:"{0}\System.Windows.Forms.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.Drawing.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.Core.dll"' -f $FrameworkDir)) + $cs
    Invoke-Captured -FilePath $Csc -ArgumentList $args -WorkingDirectory $SourceDir
}

# 编译双击启动器 LinkOK.exe（WinForms 图形界面）。
# 需要把 helper 的 QrCode.cs 一起编译进去 —— Launcher 直接引用它的编码器，
# 而不是重复实现一份 QR 逻辑。
# 注意：这个沙箱里 Start-Process -PassThru 不回填 ExitCode（实测），
# 所以判断成败要看产物是否存在。
function Build-Launcher {
    param(
        [string] $Source = (Join-Path $Root 'scripts\Launcher.cs'),
        [string] $QrSource = (Join-Path $Root 'pc\helper\QrCode.cs'),
        [string] $OutFile = (Join-Path $Root 'LinkOK.exe')
    )
    if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
    $compile = @($Source)
    if (Test-Path $QrSource) { $compile += $QrSource }
    if (-not $compile.Contains($Source)) { throw "Launcher.cs 不存在: $Source" }
    $args = @('/nologo', '/target:winexe', '/optimize+',
              '/main:Launcher',
              ('/out:"{0}"' -f $OutFile),
              ('/reference:"{0}\System.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.Core.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.Drawing.dll"' -f $FrameworkDir),
              ('/reference:"{0}\System.Windows.Forms.dll"' -f $FrameworkDir)) +
              ($compile | ForEach-Object { '"{0}"' -f $_ })
    $r = Invoke-Captured -FilePath $Csc -ArgumentList $args -WorkingDirectory $Root
    $r | Add-Member -NotePropertyName BuiltPath -NotePropertyValue $OutFile -PassThru
}

Write-Host 'LinkOK env ready' -ForegroundColor DarkGray
Write-Host ("  JAVA_HOME       = {0}" -f $env:JAVA_HOME) -ForegroundColor DarkGray
Write-Host ("  ANDROID_HOME    = {0}" -f $env:ANDROID_HOME) -ForegroundColor DarkGray
Write-Host ("  GRADLE_USER_HOME= {0}" -f $env:GRADLE_USER_HOME) -ForegroundColor DarkGray
Write-Host ("  npm cache       = {0}" -f $env:npm_config_cache) -ForegroundColor DarkGray
