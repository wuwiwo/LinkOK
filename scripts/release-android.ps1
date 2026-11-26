# LinkOK 发版脚本 —— 手机 App
#
# 用法：
#   .\scripts\release-android.ps1 -Minor "新增 Stash 批量保存"   # 0.3.2 -> 0.4.0
#   .\scripts\release-android.ps1 -Patch "修复返回键行为"        # 0.3.2 -> 0.3.3
#   .\scripts\release-android.ps1 -Patch "标题" -NoCommit        # 只改版本和 CHANGELOG
#
# 只管手机端（Kotlin + Compose）。
# 电脑端用 scripts/release-pc.ps1，两边版本独立。
#
# 规则：0.MINOR.PATCH
#   MINOR  功能变更、修复重大问题  -> 进位，PATCH 归零
#   PATCH  小 bug、文档、小改进    -> 只进 PATCH
#
# 注意：android/version.properties 里的 versionCode 由构建过程自动递增，
# 本脚本不碰它 —— 系统只用它判断能否覆盖安装。

[CmdletBinding()]
param(
    [Alias('Minor')]
    [switch] $BumpMinor,

    [Alias('Patch')]
    [switch] $BumpPatch,

    [Parameter(Mandatory, Position = 0)]
    [string] $Message,

    [switch] $NoCommit,

    # 改完版本后顺带构建并安装到已连接的手机
    [switch] $Install
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$versionFile = Join-Path $root 'android\version.config'
$changelogFile = Join-Path $root 'CHANGELOG-ANDROID.md'

if (-not (Test-Path $versionFile)) { throw "找不到 $versionFile" }

# ── 读当前版本 ──────────────────────────────────────────────
$current = $null
foreach ($line in (Get-Content $versionFile)) {
    if ($line -match '^\s*version\s*=\s*(.+?)\s*$') { $current = $Matches[1]; break }
}
if (-not $current) { throw "android/version.config 里没有 version= 行" }
if ($current -notmatch '^(\d+)\.(\d+)\.(\d+)$') {
    throw "版本号格式不对：'$current'，应为 0.MINOR.PATCH"
}
$major = [int]$Matches[1]
$minor = [int]$Matches[2]
$patchVersion = [int]$Matches[3]

# ── 计算新版本 ──────────────────────────────────────────────
if ($BumpMinor) {
    $minor += 1
    $patchVersion = 0
} else {
    $patchVersion += 1
}
$newVersion = "$major.$minor.$patchVersion"

Write-Host ""
Write-Host "  [手机 App] $current  ->  $newVersion" -ForegroundColor Cyan
Write-Host "  说明：$Message" -ForegroundColor DarkGray
Write-Host ""

# ── 1. 写回 android/version.config ──────────────────────────
$out = Get-Content $versionFile | ForEach-Object {
    if ($_ -match '^\s*version\s*=') { "version=$newVersion" } else { $_ }
}
Set-Content -Path $versionFile -Value $out -Encoding utf8
Write-Host "  ✓ android/version.config" -ForegroundColor Green
Write-Host "    (build.gradle.kts 直接读它，无需额外同步)" -ForegroundColor DarkGray

# ── 2. 插入 CHANGELOG-ANDROID 条目 ──────────────────────────
if (Test-Path $changelogFile) {
    $cl = Get-Content $changelogFile -Raw
    $today = Get-Date -Format 'yyyy-MM-dd'
    $entry = "## [$newVersion] - $today`r`n`r`n$Message`r`n`r`n---`r`n`r`n"
    $anchor = '## [Unreleased]'
    $idx = $cl.IndexOf($anchor)
    if ($idx -ge 0) {
        $afterAnchor = $cl.IndexOf("---", $idx)
        if ($afterAnchor -ge 0) {
            $insertAt = $afterAnchor + 3
            while ($insertAt -lt $cl.Length -and ($cl[$insertAt] -eq "`r" -or $cl[$insertAt] -eq "`n")) { $insertAt++ }
            $cl = $cl.Substring(0, $insertAt) + "`r`n" + $entry + $cl.Substring($insertAt)
            [System.IO.File]::WriteAllText($changelogFile, $cl, (New-Object System.Text.UTF8Encoding $false))
            Write-Host "  ✓ CHANGELOG-ANDROID.md" -ForegroundColor Green
        }
    } else {
        Write-Warning "  CHANGELOG-ANDROID.md 里找不到 '## [Unreleased]'，跳过"
    }
}

# ── 3. 可选：构建并安装 ─────────────────────────────────────
if ($Install) {
    Write-Host ""
    Write-Host "  构建 APK…" -ForegroundColor Cyan
    $env:LINKOK_TOOLCHAIN = $env:LINKOK_TOOLCHAIN
    . (Join-Path $PSScriptRoot 'env.ps1') *> $null
    $r = Invoke-Gradle -ArgumentList 'assembleDebug','--no-daemon' -WorkingDirectory (Join-Path $root 'android')
    if ($r.StdOut -notmatch 'BUILD SUCCESSFUL') {
        Write-Warning "  构建失败："
        ($r.StdErr -split "`n" | Where-Object { $_ -match '^e: ' } | Select-Object -First 8) | ForEach-Object {
            Write-Host "    $_" -ForegroundColor Red
        }
    } else {
        Write-Host "  ✓ 构建成功" -ForegroundColor Green
        $apk = Join-Path $root 'android\app\build\outputs\apk\debug\app-debug.apk'
        if (Test-Path $apk) {
            $adb = $script:Adb
            if (-not $adb) { $adb = (Get-Command adb.exe -ErrorAction SilentlyContinue).Source }
            if ($adb) {
                Write-Host "  安装到手机…" -ForegroundColor Cyan
                $install = Invoke-Captured -FilePath $adb -ArgumentList @('install','-r',$apk)
                if ($install.StdOut -match 'Success') {
                    Write-Host "  ✓ 已安装" -ForegroundColor Green
                } else {
                    Write-Warning "  安装失败：$($install.StdOut)$($install.StdErr)"
                }
            } else {
                Write-Warning "  找不到 adb，跳过安装"
            }
        }
    }
}

# ── 4. 提交并推送 ───────────────────────────────────────────
if (-not $NoCommit) {
    Push-Location $root
    try {
        git add -A 2>&1 | Out-Null
        $commitMsg = "android: v${newVersion} - $Message"
        git commit -m $commitMsg 2>&1 | Out-Null
        Write-Host "  ✓ 已提交：$commitMsg" -ForegroundColor Green

        $pushed = $false
        for ($i = 1; $i -le 6; $i++) {
            git push origin main 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
            Start-Sleep -Seconds 5
        }
        if ($pushed) {
            Write-Host "  ✓ 已推送" -ForegroundColor Green
        } else {
            Write-Warning "  推送失败（网络）。本地已提交，稍后手动 git push origin main"
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "  手机 App 版本：$newVersion" -ForegroundColor Cyan
Write-Host "  下次构建的 APK 会显示 ${newVersion}-MMdd-HHmm" -ForegroundColor DarkGray
Write-Host ""
