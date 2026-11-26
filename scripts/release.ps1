# LinkOK 发版脚本
#
# 用法：
#   .\scripts\release.ps1 -Minor "新增扫码页内取景"        # 0.3.0 -> 0.4.0
#   .\scripts\release.ps1 -Patch "修复日志洪泛"            # 0.3.0 -> 0.3.1
#   .\scripts\release.ps1 -Minor "标题" -NoCommit          # 只改版本和 CHANGELOG
#
# 做四件事：
#   1. 按规则递增 version.config 里的语义版本
#   2. 同步 pc/package.json
#   3. 在 CHANGELOG.md 的 ## [Unreleased] 之后插入新条目
#   4. git add / commit / push
#
# 规则（开发阶段）：
#   MINOR  功能变更、修复重大问题        -> 进位，PATCH 归零
#   PATCH  小 bug、文档、小改进          -> 只进 PATCH

[CmdletBinding()]
param(
    [Alias('Minor')]
    [switch] $BumpMinor,

    [Alias('Patch')]
    [switch] $BumpPatch,

    [Parameter(Mandatory, Position = 0)]
    [string] $Message,

    [switch] $NoCommit
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$versionFile = Join-Path $root 'version.config'
$changelogFile = Join-Path $root 'CHANGELOG.md'
$pkgFile = Join-Path $root 'pc\package.json'

if (-not (Test-Path $versionFile)) { throw "找不到 $versionFile" }

# ── 读当前版本 ──────────────────────────────────────────────
$lines = Get-Content $versionFile
$current = $null
foreach ($line in $lines) {
    if ($line -match '^\s*version\s*=\s*(.+?)\s*$') { $current = $Matches[1]; break }
}
if (-not $current) { throw "version.config 里没有 version= 行" }
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
Write-Host "  版本：$current  ->  $newVersion" -ForegroundColor Cyan
Write-Host "  说明：$Message" -ForegroundColor DarkGray
Write-Host ""

# ── 1. 写回 version.config ──────────────────────────────────
$out = $lines | ForEach-Object {
    if ($_ -match '^\s*version\s*=') { "version=$newVersion" } else { $_ }
}
Set-Content -Path $versionFile -Value $out -Encoding utf8
Write-Host "  ✓ version.config" -ForegroundColor Green

# ── 2. 同步 package.json ────────────────────────────────────
if (Test-Path $pkgFile) {
    $pkg = Get-Content $pkgFile -Raw
    $pkg = $pkg -replace '"version":\s*"[^"]*"', "`"version`": `"$newVersion`""
    [System.IO.File]::WriteAllText($pkgFile, $pkg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  ✓ pc/package.json" -ForegroundColor Green
}

# ── 3. 插入 CHANGELOG 条目 ──────────────────────────────────
if (Test-Path $changelogFile) {
    $cl = Get-Content $changelogFile -Raw
    $today = Get-Date -Format 'yyyy-MM-dd'
    $entry = @"
## [$newVersion] — $today

$Message

---

"@
    # 插在 Unreleased 段之后、第一个已发布版本之前
    $anchor = '## [Unreleased]'
    $idx = $cl.IndexOf($anchor)
    if ($idx -ge 0) {
        $afterAnchor = $cl.IndexOf("`n---", $idx)
        if ($afterAnchor -ge 0) {
            $insertAt = $afterAnchor + 5
            $cl = $cl.Substring(0, $insertAt) + "`n" + $entry + $cl.Substring($insertAt).TrimStart("`r", "`n")
        } else {
            $cl = $cl.Substring(0, $idx) + $entry + $cl.Substring($idx)
        }
        [System.IO.File]::WriteAllText($changelogFile, $cl, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "  ✓ CHANGELOG.md" -ForegroundColor Green
    } else {
        Write-Warning "  CHANGELOG.md 里找不到 '## [Unreleased]'，跳过"
    }
}

# ── 4. 提交并推送 ───────────────────────────────────────────
if (-not $NoCommit) {
    Push-Location $root
    try {
        git add -A 2>&1 | Out-Null
        $commitMsg = "v${newVersion}: $Message"
        git commit -m $commitMsg 2>&1 | Out-Null
        Write-Host "  ✓ 已提交：$commitMsg" -ForegroundColor Green

        # 推送。网络不稳时重试几次 —— 这台机器到 github 的连接经常被重置。
        $pushed = $false
        for ($i = 1; $i -le 5; $i++) {
            git push origin main 2>&1 | Out-Null
            if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
            Start-Sleep -Seconds 4
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
Write-Host "  完成。下一步：" -ForegroundColor Cyan
Write-Host "    构建 APK：. .\scripts\env.ps1; Invoke-Gradle assembleDebug" -ForegroundColor DarkGray
Write-Host ""
