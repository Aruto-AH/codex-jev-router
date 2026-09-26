[CmdletBinding(DefaultParameterSetName = 'File')]
param(
    [Parameter(Mandatory = $true, Position = 0, ParameterSetName = 'File')]
    [ValidateNotNullOrEmpty()]
    [string]$PromptFile,

    [Parameter(Mandatory = $true, ParameterSetName = 'Text')]
    [ValidateNotNullOrEmpty()]
    [string]$Prompt
)

$ErrorActionPreference = 'Stop'
$previousBackend = [Environment]::GetEnvironmentVariable('ROUTER_BACKEND', 'Process')
$previousShadow = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_SHADOW', 'Process')
$previousPromptFile = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_PROMPT_FILE', 'Process')
$previousRouteFile = [Environment]::GetEnvironmentVariable('CODEX_ROUTER_ROUTE_FILE', 'Process')
$reportDirectory = Join-Path $PSScriptRoot '.codex-router'
$reportPath = Join-Path $reportDirectory 'last-report.txt'
$temporaryReport = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryPrompt = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryError = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$temporaryRoute = Join-Path $reportDirectory ([IO.Path]::GetRandomFileName())
$exitCode = 1

try {
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

    $ErrorActionPreference = 'Continue'
    & node (Join-Path $PSScriptRoot 'bin\jev-codex.mjs') exec `
        --config 'approval_policy="never"' `
        --config 'sandbox_mode="workspace-write"' `
        --output-last-message $temporaryReport - 2> $temporaryError | Out-Null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($exitCode -ne 0) {
        if (Test-Path -LiteralPath $temporaryError -PathType Leaf) {
            $codexError = [IO.File]::ReadAllText($temporaryError, [Text.Encoding]::UTF8).Trim()
            if ($codexError) { [Console]::Error.WriteLine($codexError) }
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

    [IO.File]::Copy($temporaryReport, $reportPath, $true)
    $reportText = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8)
    Set-Clipboard -Value $reportText
    Write-Output "Routed: $($appliedRoute.model) / $($appliedRoute.effort)"
    Write-Output "Codex report saved: $reportPath"
    Write-Output 'Report copied to clipboard.'
} catch {
    if ($exitCode -eq 0) { $exitCode = 1 }
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    [Environment]::SetEnvironmentVariable('ROUTER_BACKEND', $previousBackend, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_SHADOW', $previousShadow, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_PROMPT_FILE', $previousPromptFile, 'Process')
    [Environment]::SetEnvironmentVariable('CODEX_ROUTER_ROUTE_FILE', $previousRouteFile, 'Process')
    Remove-Item -LiteralPath $temporaryReport -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryPrompt -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryError -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryRoute -Force -ErrorAction SilentlyContinue
}

exit $exitCode
