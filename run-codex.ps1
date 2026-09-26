[CmdletBinding(DefaultParameterSetName = 'File')]
param(
    [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'File')]
    [ValidateNotNullOrEmpty()]
    [string]$PromptFile,

    [Parameter(Mandatory = $true, ParameterSetName = 'Text')]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt,

    [ValidateNotNullOrEmpty()]
    [string]$ResumeSessionId
)

$ErrorActionPreference = 'Stop'
$callerWorkingDirectory = (Get-Location -PSProvider FileSystem).ProviderPath
$previousBackend = [Environment]::GetEnvironmentVariable('ROUTER_BACKEND', 'Process')
$previousShadow = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_SHADOW', 'Process')
$previousPromptFile = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_PROMPT_FILE', 'Process')
$previousRouteFile = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_ROUTE_FILE', 'Process')
$reportDirectory = Join-Path $PSScriptRoot '.codex-router'
$reportPath = Join-Path $reportDirectory 'last-report.txt'
$temporaryReport = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryPrompt = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryError = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryOutput = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryRoute = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$exitCode = 1
$codexProcess = $null
$processStarted = $false
$stderrPrinted = $false

function Format-ElapsedTime([TimeSpan]$elapsed) {
    return '{0:00}:{1:00}' -f [Math]::Floor($elapsed.TotalMinutes), $elapsed.Seconds
}

function Quote-ProcessArgument([string]$argument) {
    if ($argument -notmatch '[\s"]') { return $argument }
    return '"' + ($argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

try {
    Write-Output 'Routing request...'
    if ($PSCmdlet.ParameterSetName -eq 'File') {
        $resolvedPrompt = (Resolve-Path -LiteralPath $PromptFile).ProviderPath
        $promptText = [IO.File]::ReadAllText($resolvedPrompt, [Text.UTF8Encoding]::new($false, $true))
    } else {
        $promptText = $Prompt
    }
    if ([string]::IsNullOrWhiteSpace($promptText)) {
        throw 'Prompt is empty.'
    }

    New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
    [IO.File]::WriteAllText($temporaryPrompt, $promptText, [Text.UTF8Encoding]::new($false))
    $env:ROUTER_BACKEND = 'gpt'
    $env:CODEX_ROUTER_SHADOW = '0'
    $env:CODEX_ROUTER_PROMPT_FILE = $temporaryPrompt
    $env:CODEX_ROUTER_ROUTE_FILE = $temporaryRoute

    $codexArguments = @('exec')
    if ($PSBoundParameters.ContainsKey('ResumeSessionId')) {
        $codexArguments += 'resume'
    }
    $codexArguments += @(
        '--config', 'approval_policy="never"',
        '--config', 'sandbox_mode="workspace-write"',
        '--output-last-message', $temporaryReport
    )
    if ($PSBoundParameters.ContainsKey('ResumeSessionId')) {
        $codexArguments += $ResumeSessionId
    }
    $codexArguments += '-'

    $heartbeatIntervalMs = 10000
    if ($env:CODEX_ROUTER_HEARTBEAT_INTERVAL_MS) {
        $heartbeatIntervalMs = [int]$env:CODEX_ROUTER_HEARTBEAT_INTERVAL_MS
        if ($heartbeatIntervalMs -lt 1) { throw 'Heartbeat interval must be positive.' }
    }
    $processArguments = @((Join-Path $PSScriptRoot 'bin\jev-codex.mjs')) + $codexArguments
    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $startInfo.WorkingDirectory = $callerWorkingDirectory
    $startInfo.Arguments = ($processArguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' '
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.RedirectStandardInput = $true
    $startInfo.CreateNoWindow = $true
    $codexProcess = [Diagnostics.Process]::new()
    $codexProcess.StartInfo = $startInfo
    $outputStream = $null
    $errorStream = $null
    $outputCopy = $null
    $errorCopy = $null
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $outputStream = [IO.File]::Create($temporaryOutput)
        $errorStream = [IO.File]::Create($temporaryError)
        Write-Output 'Codex starting...'
        [void]$codexProcess.Start()
        $processStarted = $true
        $codexProcess.StandardInput.Close()
        $outputCopy = $codexProcess.StandardOutput.BaseStream.CopyToAsync($outputStream)
        $errorCopy = $codexProcess.StandardError.BaseStream.CopyToAsync($errorStream)
        $nextHeartbeatMs = $heartbeatIntervalMs
        while (-not $codexProcess.HasExited) {
            $remainingMs = [Math]::Max(1, [int][Math]::Ceiling($nextHeartbeatMs - $timer.Elapsed.TotalMilliseconds))
            [void]$codexProcess.WaitForExit($remainingMs)
            if (-not $codexProcess.HasExited -and $timer.Elapsed.TotalMilliseconds -ge $nextHeartbeatMs) {
                Write-Output "Codex running... $(Format-ElapsedTime $timer.Elapsed)"
                $nextHeartbeatMs = ([Math]::Floor($timer.Elapsed.TotalMilliseconds / $heartbeatIntervalMs) + 1) * $heartbeatIntervalMs
            }
        }
        if (-not [Threading.Tasks.Task]::WaitAll(
            [Threading.Tasks.Task[]]@($outputCopy, $errorCopy), 30000)) {
            throw 'Codex output streams did not close after the process exited.'
        }
        [void]$outputCopy.GetAwaiter().GetResult()
        [void]$errorCopy.GetAwaiter().GetResult()
        $exitCode = $codexProcess.ExitCode
    } finally {
        $timer.Stop()
        if ($processStarted -and -not $codexProcess.HasExited) {
            try { & taskkill.exe /PID $codexProcess.Id /T /F 2>$null | Out-Null } catch {}
        }
        $copies = @($outputCopy, $errorCopy) | Where-Object { $null -ne $_ }
        if ($copies.Count -gt 0) {
            try { [void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$copies, 5000) } catch {}
        }
        if ($processStarted) {
            $codexProcess.StandardOutput.BaseStream.Dispose()
            $codexProcess.StandardError.BaseStream.Dispose()
        }
        if ($outputStream) { $outputStream.Dispose() }
        if ($errorStream) { $errorStream.Dispose() }
    }
    if ($exitCode -ne 0) {
        Write-Output "Codex failed after $(Format-ElapsedTime $timer.Elapsed)"
        if (Test-Path -LiteralPath $temporaryError -PathType Leaf) {
            $codexError = [IO.File]::ReadAllText($temporaryError, [Text.Encoding]::UTF8).Trim()
            if ($codexError) {
                [Console]::Error.WriteLine($codexError)
                $stderrPrinted = $true
            }
        }
        throw "Codex failed with exit code $exitCode."
    }
    if (-not (Test-Path -LiteralPath $temporaryReport -PathType Leaf)) {
        throw 'Codex did not create a final report.'
    }
    if (-not (Test-Path -LiteralPath $temporaryRoute -PathType Leaf)) {
        throw 'Codex did not record an applied route.'
    }
    $appliedRoute = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($temporaryRoute, [Text.Encoding]::UTF8))
    if ($appliedRoute.model -notin @('gpt-6-luna', 'gpt-6-sol') -or
        $appliedRoute.effort -notin @('low', 'medium', 'high', 'max')) {
        throw 'Codex recorded an invalid applied route.'
    }
    Write-Output "Routed: $($appliedRoute.model) / $($appliedRoute.effort)"

    [IO.File]::Copy($temporaryReport, $reportPath, $true)
    $reportText = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8)
    Set-Clipboard -Value $reportText
    Write-Output "Codex finished in $(Format-ElapsedTime $timer.Elapsed)"
    Write-Output "Codex report saved: $reportPath"
    Write-Output 'Report copied to clipboard.'
} catch {
    if ($exitCode -eq 0) { $exitCode = 1 }
    if (-not $stderrPrinted -and (Test-Path -LiteralPath $temporaryError -PathType Leaf)) {
        $codexError = [IO.File]::ReadAllText($temporaryError, [Text.Encoding]::UTF8).Trim()
        if ($codexError) { [Console]::Error.WriteLine($codexError) }
    }
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    if ($codexProcess) {
        $codexProcess.Dispose()
    }
    [Environment]::SetEnvironmentVariable('ROUTER_BACKEND', $previousBackend, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_SHADOW', $previousShadow, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_PROMPT_FILE', $previousPromptFile, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_ROUTE_FILE', $previousRouteFile, 'Process')
    Remove-Item -LiteralPath $temporaryReport -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryPrompt -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryError -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryOutput -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryRoute -Force -ErrorAction SilentlyContinue
}

exit $exitCode
