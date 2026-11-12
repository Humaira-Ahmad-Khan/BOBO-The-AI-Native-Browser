<#
.SYNOPSIS
  Self-check for scripts/hooks/agent-guard.ps1 - no framework, just asserts.

  Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/hooks/agent-guard.tests.ps1
  Exits non-zero (1) if any expectation fails. A missing/failing guard must fail loudly.
#>
$ErrorActionPreference = 'Stop'

$root  = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$guard = Join-Path $PSScriptRoot 'agent-guard.ps1'
$payloadFile = Join-Path $PSScriptRoot '.payload.tmp'

function Invoke-Guard([string]$Payload) {
    [System.IO.File]::WriteAllText($payloadFile, $Payload)
    try {
        # cmd stdin redirection so the guard's [Console]In.ReadToEnd() really sees it.
        $out = cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -File `"$guard`" < `"$payloadFile`""
        $json = ($out -join "`n").Trim()
        if ([string]::IsNullOrWhiteSpace($json)) { return 'NO_OUTPUT' }
        try { return ($json | ConvertFrom-Json).hookSpecificOutput.permissionDecision }
        catch { return 'BAD_JSON' }
    } finally {
        Remove-Item -LiteralPath $payloadFile -Force -ErrorAction SilentlyContinue
    }
}

function New-Payload([string]$Tool, [object]$ToolInput, [string]$Cwd) {
    # NB: never name a parameter $Input - it is a reserved automatic variable in
    # PowerShell and would silently serialize as empty, disabling the guard checks.
    (@{ tool_name = $Tool; tool_input = $ToolInput; cwd = $Cwd } | ConvertTo-Json -Depth 6 -Compress)
}

$failures = 0
function Assert-Decision([string]$Name, [string]$Actual, [string]$Expected) {
    if ($Actual -eq $Expected) {
        Write-Host "  PASS  $Name -> $Actual"
    } else {
        Write-Host "  FAIL  $Name -> expected $Expected, got $Actual" -ForegroundColor Red
        $script:failures++
    }
}

Write-Host "agent-guard self-check (root: $root)"

# 1. Path inside project -> allow
Assert-Decision 'read inside project' `
    (Invoke-Guard (New-Payload 'Read' @{ file_path = 'src\app\index.ts' } $root)) 'allow'

# 2. Path outside project -> deny
Assert-Decision 'read outside project' `
    (Invoke-Guard (New-Payload 'Read' @{ file_path = 'C:\Windows\System32\config\SAM' } $root)) 'deny'

# 3. Absolute user path outside project -> deny
Assert-Decision 'read home dir' `
    (Invoke-Guard (New-Payload 'Write' @{ file_path = 'C:\Users\Rising\.ssh\id_rsa' } $root)) 'deny'

# 4. Relative escape via .. -> deny
Assert-Decision 'relative escape' `
    (Invoke-Guard (New-Payload 'Edit' @{ file_path = '..\..\..\secret.txt' } $root)) 'deny'

# 5. Network command -> deny
Assert-Decision 'curl' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'curl https://example.com' } $root)) 'deny'

# 6. Package install -> deny
Assert-Decision 'pip install' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'pip install requests' } $root)) 'deny'

# 7. Safe local command -> allow
Assert-Decision 'git status' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'git status' } $root)) 'allow'

# 8. Out-of-project traversal in command -> deny
Assert-Decision 'cd traversal' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'cd ../../ && ls' } $root)) 'deny'

# 9. Empty payload -> fail closed (deny)
Assert-Decision 'empty payload' (Invoke-Guard '') 'deny'

# 10. Unparseable payload -> fail closed (deny)
Assert-Decision 'garbage payload' (Invoke-Guard 'not-json{') 'deny'

# 11. Graphify-dependent command -> deny while policy records not-approved
Assert-Decision 'graphify query' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'graphify query "how does auth work"' } $root)) 'deny'

# 12. Reading the policy is not a Graphify command -> allow
Assert-Decision 'read graphify policy' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'cat graphify.policy.json' } $root)) 'allow'

# 13. Searching for the word graphify is not a Graphify command -> allow
Assert-Decision 'grep graphify docs' `
    (Invoke-Guard (New-Payload 'Bash' @{ command = 'grep graphify AGENTS.md' } $root)) 'allow'

if ($failures -gt 0) {
    Write-Host "`n$failures check(s) FAILED - the guard does not enforce correctly." -ForegroundColor Red
    exit 1
}
Write-Host "`nAll checks passed - guard enforces project boundary and network rules."
exit 0
