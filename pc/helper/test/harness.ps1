# LinkOK helper — interactive protocol harness (test only, runs the exe for real).
#
# The sandbox forbids a *child* process from capturing another program's stdout through
# pipes (EPERM on \\.\pipe\...), but the parent PowerShell process may create pipes and
# .NET Process redirection works from here. So the harness drives the helper's stdin/stdout
# with a Process object instead of Start-Process.
#
# Usage:
#   . .\harness.ps1
#   $h = Start-Helper            # fresh helper, stdin/stdout attached
#   $h.Write('{"cmd":"start"}')
#   $h.Read(2000)                # lines received so far
#   $h.Stop()

$ErrorActionPreference = 'Stop'

$script:HelperExe = '<项目根>\pc\helper\linkok-helper.exe'
$script:RunDir    = '<项目根>\.tmp-run'

function Start-Helper {
    param(
        [string] $ScreenshotDir = $script:RunDir,
        [string] $LogFile = (Join-Path $script:RunDir 'helper.log'),
        [string[]] $InitialLines = @()
    )
    Get-Process linkok-helper -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 250

    New-Item -ItemType Directory -Force -Path $script:RunDir | Out-Null
    Remove-Item $LogFile -Force -ErrorAction SilentlyContinue

    $env:LINKOK_SCREENSHOT_DIR = $ScreenshotDir
    $env:LINKOK_HELPER_TMP     = Join-Path $script:RunDir 'tmp'
    $env:LINKOK_HELPER_LOG     = $LogFile
    New-Item -ItemType Directory -Force -Path $env:LINKOK_HELPER_TMP | Out-Null

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $script:HelperExe
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
    $psi.StandardErrorEncoding  = New-Object System.Text.UTF8Encoding $false
    $psi.WorkingDirectory       = $script:RunDir

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    # Drain stderr on a background thread so the child never blocks on a full pipe.
    $errLines = New-Object System.Collections.ArrayList
    $errState = [hashtable]::Synchronized(@{ Lines = $errLines })
    $null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
        $Event.MessageData.Lines.Add($Event.SourceEventArgs.Data) | Out-Null
    } -MessageData $errState
    $proc.BeginErrorReadLine()

    $handle = [pscustomobject]@{
        Process   = $proc
        ErrState  = $errState
        LogFile   = $LogFile
        PID       = $proc.Id
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name Write -Value {
        param([string] $Line)
        $this.Process.StandardInput.WriteLine($Line)
        $this.Process.StandardInput.Flush()
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name WriteRaw -Value {
        param([string] $Text)
        $this.Process.StandardInput.Write($Text)
        $this.Process.StandardInput.Flush()
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name ReadLines -Value {
        param([int] $TimeoutMs = 1500)
        $lines = New-Object System.Collections.ArrayList
        $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
        while ([DateTime]::UtcNow -lt $deadline) {
            $task = $this.Process.StandardOutput.ReadLineAsync()
            if ($task.Wait(200)) {
                if ($null -eq $task.Result) { break }   # EOF
                $lines.Add($task.Result) | Out-Null
                $deadline = [DateTime]::UtcNow.AddMilliseconds(250)  # keep draining while data flows
            }
        }
        return $lines
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name Stderr -Value {
        return ($this.ErrState.Lines -join "`n")
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name CloseStdin -Value {
        $this.Process.StandardInput.Close()
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name Stop -Value {
        try { if (-not $this.Process.HasExited) { $this.Process.Kill() } } catch { }
        $this.Process.WaitForExit(3000) | Out-Null
    }
    Add-Member -InputObject $handle -MemberType ScriptMethod -Name WaitExit -Value {
        param([int] $TimeoutMs = 5000)
        return $this.Process.WaitForExit($TimeoutMs)
    }

    foreach ($line in $InitialLines) { $handle.Write($line) }
    return $handle
}
