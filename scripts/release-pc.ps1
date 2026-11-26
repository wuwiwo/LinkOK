# LinkOK 发版脚本 —— 电脑端
#
# 用法：
#   .\scripts\release-pc.ps1 -Minor "新增剪贴板历史接口"     # 0.3.2 -> 0.4.0
#   .\scripts\release-pc.ps1 -Patch "修复日志轮转边界"        # 0.3.2 -> 0.3.3
#   .\scripts\release-pc.ps1 -Patch "标题" -NoCommit          # 只改版本和 CHANGELOG
#
# 只管电脑端（Node Hub + C# helper + 设置页）。
# 手机端用 scripts/release-android.ps1，两边版本独立。
#
# 规则：0.MINOR.PATCH
#   MINOR  功能变更、修复重大问题  -> 进位，PATCH 归零
#   PATCH  小 bug、文档、小改进    -> 只进 PATCH

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
$changelogFile = Join-Path $root 'CHANGELOG-PC.md'
$pkgFile = Join-Path $root 'pc\package.json'

if (-not (Test-Path $versionFile)) { throw "找不到 $versionFile" }

# ── 读当前版本 ──────────────────────────────────────────────
$current = $null
foreach ($line in (Get-Content $versionFile)) {
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
Write-Host "  [电脑端] $current  ->  $newVersion" -ForegroundColor Cyan
Write-Host "  说明：$Message" -ForegroundColor DarkGray
Write-Host ""

# ── 1. 写回 version.config ──────────────────────────────────
$out = Get-Content $versionFile | ForEach-Object {
    if ($_ -match '^\s*version\s*=') { "version=$newVersion" } else { $_ }
}
Set-Content -Path $versionFile -Value $out -Encoding utf8
Write-Host "  ✓ version.config" -ForegroundColor Green

# ── 2. 同步 pc/package.json ─────────────────────────────────
if (Test-Path $pkgFile) {
    $pkg = Get-Content $pkgFile -Raw
    $pkg = $pkg -replace '"version":\s*"[^"]*"', "`"version`": `"$newVersion`""
    [System.IO.File]::WriteAllText($pkgFile, $pkg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "  ✓ pc/package.json" -ForegroundColor Green
}

# ── 3. 插入 CHANGELOG-PC 条目 ───────────────────────────────
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
            Write-Host "  ✓ CHANGELOG-PC.md" -ForegroundColor Green
        }
    } else {
        Write-Warning "  CHANGELOG-PC.md 里找不到 '## [Unreleased]'，跳过"
    }
}

# ── 4. 提交并推送 ───────────────────────────────────────────
if (-not $NoCommit) {
    Push-Location $root
    try {
        git add -A 2>&1 | Out-Null
        $commitMsg = "pc: v${newVersion} - $Message"
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
Write-Host "  电脑端版本：$newVersion" -ForegroundColor Cyan
Write-Host "  重启 Hub 生效（双击 LinkOK.exe）" -ForegroundColor DarkGray
Write-Host ""
