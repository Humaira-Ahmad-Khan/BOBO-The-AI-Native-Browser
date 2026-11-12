<#
.SYNOPSIS
  PreToolUse guard for Claude Code (and reusable by any agent that can shell out).

.DESCRIPTION
  Reads the Claude Code PreToolUse JSON payload on stdin and denies any tool call that
  would (a) read/write a path outside the project root, or (b) run a network / exfil /
  destructive command. Emits the standard hook JSON on stdout with permissionDecision.

  Fail-safe: any parse error or unknown state defaults to DENY for path-bearing and
  command-bearing tools, and the script never blocks the operator from seeing why.

  Root resolution order:
    1. $env:CLAUDE_PROJECT_DIR (set by Claude Code)
    2. This script's own location (scripts/hooks -> repo root), so cwd never matters.
#>

$ErrorActionPreference = 'Stop'

# Emit UTF-8 so reason text (paths may be non-ASCII) survives redirection.
try { [System.Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# Payloads are always UTF-8 JSON; never decode stdin with the console codepage.
# Console.In would mangle non-ASCII paths (e.g. an em-dash in the repo name).
function Read-StdinUtf8 {
    try {
        $stdin = [System.Console]::OpenStandardInput()
        $sr = New-Object System.IO.StreamReader($stdin, (New-Object System.Text.UTF8Encoding($false)))
        return $sr.ReadToEnd()
    } catch { return '' }
}

function Get-ProjectRoot {
    if ($env:CLAUDE_PROJECT_DIR -and (Test-Path -LiteralPath $env:CLAUDE_PROJECT_DIR)) {
        return (Resolve-Path -LiteralPath $env:CLAUDE_PROJECT_DIR).Path
    }
    # scripts/hooks/agent-guard.ps1 -> repo root is two levels up
    return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
}

function Test-InsideRoot([string]$Path, [string]$Root, [string]$BaseDir) {
    if ([string]::IsNullOrWhiteSpace($Path)) { return $true }  # nothing to check
    $candidate = $Path
    try {
        if (-not [System.IO.Path]::IsPathRooted($candidate)) {
            $candidate = Join-Path $BaseDir $candidate
        }
        $candidate = [System.IO.Path]::GetFullPath($candidate)
    } catch {
        return $false  # unresolvable -> unsafe
    }
    $rootFull = [System.IO.Path]::GetFullPath($Root)
    return $candidate.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

# Network / exfil / destructive commands. First match wins; case-insensitive.
$DeniedCommandPatterns = @(
    '\bcurl\b', '\bwget\b', '\biwr\b', '\birm\b',
    'Invoke-WebRequest', 'Invoke-RestMethod', '\biex\b',
    '\bnc\b', '\bnetcat\b', '\btelnet\b', '\bssh\b', '\bscp\b', '\bftp\b',
    'Start-BitsTransfer', 'bitsadmin',
    'git\s+push', 'git\s+remote\s+add',
    'npm\s+(install|i|add)\b', '\byarn\b', 'pnpm\s+(install|add)\b',
    'pip3?\s+install', 'uv\s+(pip|add|sync|tool)', '\buvx\b',
    '\bcargo\s+(install|add)\b', '\bgo\s+get\b',
    '\brm\b', '\brmdir\b', 'Remove-Item', '\bdel\b',
    '\bformat\b', '\bdiskpart\b',
    'Out-File.*(?:\.ssh|\.aws|\.env)', '\btee\b.*(?:\.ssh|\.aws)'
)

function Deny([string]$Reason) {
    $out = @{
        hookSpecificOutput = @{
            hookEventName       = 'PreToolUse'
            permissionDecision  = 'deny'
            permissionDecisionReason = $Reason
        }
    }
    $out | ConvertTo-Json -Depth 6 -Compress
    exit 0
}

$raw = Read-StdinUtf8
if ([string]::IsNullOrWhiteSpace($raw)) {
    # No payload -> cannot verify -> fail closed for safety of the boundary.
    Deny 'agent-guard: received empty hook payload; refusing to run unverified tool call.'
}

try {
    $payload = $raw | ConvertFrom-Json
} catch {
    Deny 'agent-guard: could not parse hook payload; failing closed.'
}

$root     = Get-ProjectRoot
$toolName = [string]$payload.tool_name
$cwd      = [string]$payload.cwd
if ([string]::IsNullOrWhiteSpace($cwd)) { $cwd = $root }
$ti       = $payload.tool_input

# --- 1. Path containment for file-bearing tools -------------------------------
$pathTools = @('Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
if ($pathTools -contains $toolName) {
    foreach ($field in @('file_path', 'notebook_path', 'path')) {
        $p = $ti.$field
        if ($p -and -not (Test-InsideRoot -Path ([string]$p) -Root $root -BaseDir $cwd)) {
            Deny ("agent-guard: '$toolName' blocked - path '$p' is outside the project root '$root'. " +
                  "Stay inside the project folder (AGENTS.md section 0.1).")
        }
    }
}

# --- 2. Command containment for shell tool ------------------------------------
if ($toolName -eq 'Bash' -or $toolName -eq 'Shell') {
    $cmd = [string]$ti.command
    foreach ($pat in $DeniedCommandPatterns) {
        if ($cmd -match $pat) {
            Deny ("agent-guard: command blocked by pattern '$pat'. " +
                  "Network / destructive / out-of-project actions need explicit human approval " +
                  "(AGENTS.md section 0.2).")
        }
    }
    # Block explicit traversal out of the project via cd / path arguments.
    if ($cmd -match '(?:\.\.[\/\\]){2,}' -or $cmd -match '(?:^|[\s"''])/(?:Users|etc|var|home)\b' -or $cmd -match '(?:^|[\s"''])[A-Za-z]:\\(?:Users|Windows)\b') {
        Deny 'agent-guard: command references a path outside the project folder (AGENTS.md section 0.1).'
    }

    # Graphify-dependent commands stay blocked until graphify.policy.json records an
    # approved installation. Reading the policy itself is not a Graphify command, so the
    # match requires command position (or an explicit `-m graphify` module invocation).
    $graphifyCommand = '(?:(?:^|[;&|(\r\n])\s*)(?:[^\s"'']*[\/\\])?(?:graphify|graphify\.exe)(?:\s|$|[;&|"''])|(?:^|\s)-{1,2}m\s+graphify\b'
    if ($cmd -match $graphifyCommand) {
        $graphifyApproved = $false
        $policyPath = Join-Path $root 'graphify.policy.json'
        if (Test-Path -LiteralPath $policyPath) {
            try {
                $graphifyPolicy = Get-Content -LiteralPath $policyPath -Raw -ErrorAction Stop | ConvertFrom-Json
                if ($graphifyPolicy.installation.approved -eq $true -and
                    $graphifyPolicy.graphifyDependentActions -eq 'allowed') {
                    $graphifyApproved = $true
                }
            } catch {
                $graphifyApproved = $false
            }
        }
        if (-not $graphifyApproved) {
            Deny ('agent-guard: Graphify is not approved in graphify.policy.json (AGENTS.md section 6). ' +
                  'Graphify-dependent commands stay blocked until the installation is explicitly approved.')
        }
    }
}

# --- Allow --------------------------------------------------------------------
@{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'allow'; permissionDecisionReason = 'agent-guard: within project boundaries.' } } |
    ConvertTo-Json -Depth 6 -Compress
exit 0
