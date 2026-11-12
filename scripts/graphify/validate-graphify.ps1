<#
.SYNOPSIS
  Project-local Graphify policy and Git-hook validator.

.DESCRIPTION
  Read-only. This script never runs graphify, never fetches/pulls/clones, never
  installs packages, and never touches the network. It validates AGENTS.md section 6,
  graphify.policy.json, and (for Git events) the staged or pushed changes.

  Modes:
    session     Read AGENTS.md + policy, report local state; unrelated work is not blocked.
    policy      Validate AGENTS.md + graphify.policy.json only.
    pre-commit  Policy + staged secret/binary/out-of-project + protected Graphify paths.
    pre-push    Policy + local hooksPath + pushed-range Graphify changes + push approval.

  Exit code 0 = pass, 1 = blocked/failed. Fail closed on unreadable or invalid input.
#>

param(
    [ValidateSet('session', 'policy', 'pre-commit', 'pre-push')]
    [string]$Mode = 'session',

    [string]$RemoteName = '',
    [string]$RemoteUrl = '',
    [string]$PushRefsFile = ''
)

$ErrorActionPreference = 'Stop'

# scripts/graphify/validate-graphify.ps1 -> repository root
$script:Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$script:Failures = New-Object 'System.Collections.Generic.List[string]'
$script:Warnings = New-Object 'System.Collections.Generic.List[string]'
$script:Policy = $null

function Write-Info([string]$Message) {
    Write-Host "[graphify] $Message"
}

function Write-Warn([string]$Message) {
    Write-Host "[graphify] WARNING: $Message" -ForegroundColor Yellow
    $script:Warnings.Add($Message) | Out-Null
}

function Write-Fail([string]$Message) {
    Write-Host "[graphify] BLOCKED: $Message" -ForegroundColor Red
    $script:Failures.Add($Message) | Out-Null
}

function Invoke-GitText {
    param([string[]]$GitArguments)

    # Native git writes some expected probes (e.g. cat-file -e on a missing path) to
    # stderr. Capture them as data instead of letting $ErrorActionPreference turn them
    # into a terminating error; the exit code is the authority.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git -C $script:Root @GitArguments 2>&1
        $code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }

    # Keep stdout lines only; stderr is represented as ErrorRecords when merged. We do
    # not need the text, only the exit code and stdout.
    $stdout = @($output | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
    return @{
        Code   = $code
        Output = $stdout
    }
}

function Read-ProjectText {
    param(
        [string]$RelativePath,
        [string]$Source,
        [string]$Ref
    )

    if ($Source -eq 'ref') {
        if ([string]::IsNullOrWhiteSpace($Ref)) { return $null }
        $probe = Invoke-GitText @('cat-file', '-e', "${Ref}:$RelativePath")
        if ($probe.Code -ne 0) { return $null }
        $show = Invoke-GitText @('show', "${Ref}:$RelativePath")
        if ($show.Code -ne 0) { return $null }
        return ($show.Output -join "`n")
    }

    if ($Source -eq 'index') {
        $probe = Invoke-GitText @('cat-file', '-e', ":$RelativePath")
        if ($probe.Code -ne 0) { return $null }
        $show = Invoke-GitText @('show', ":$RelativePath")
        if ($show.Code -ne 0) { return $null }
        return ($show.Output -join "`n")
    }

    $full = Join-Path $script:Root $RelativePath
    if (-not (Test-Path -LiteralPath $full)) { return $null }
    return (Get-Content -LiteralPath $full -Raw -ErrorAction Stop)
}

function Test-ProtectedPath {
    param([string]$Path)

    if ($null -eq $script:Policy) { return $false }
    $normalized = ($Path -replace '\\', '/')

    foreach ($prefixValue in @($script:Policy.protectedPaths)) {
        $prefix = ([string]$prefixValue -replace '\\', '/')
        if ([string]::IsNullOrWhiteSpace($prefix)) { continue }
        if ($prefix.EndsWith('/')) {
            if ($normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
        elseif ($normalized.Equals($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
                $normalized.StartsWith($prefix + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    foreach ($fileValue in @($script:Policy.protectedFiles)) {
        $file = ([string]$fileValue -replace '\\', '/')
        if ($normalized.Equals($file, [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }

    return $false
}

function Test-Policy {
    param(
        [string]$Source,
        [string]$Ref
    )

    $before = $script:Failures.Count

    # AGENTS.md is the rule of record. The policy section must point at both the
    # machine-readable record and the validator, so the three can never drift apart.
    $agents = Read-ProjectText 'AGENTS.md' $Source $Ref
    if ([string]::IsNullOrWhiteSpace($agents)) {
        Write-Fail "AGENTS.md is missing or empty in $Source; cannot verify the central rules."
    }
    else {
        if ($agents -notmatch '(?m)^##\s+6\.\s+Graphify policy \(local, offline\)\s*$') {
            Write-Fail "AGENTS.md is missing the required '## 6. Graphify policy (local, offline)' section."
        }
        if ($agents -notmatch 'graphify\.policy\.json') {
            Write-Fail 'AGENTS.md section 6 must reference graphify.policy.json.'
        }
        if ($agents -notmatch 'scripts/graphify/validate-graphify\.ps1') {
            Write-Fail 'AGENTS.md section 6 must reference scripts/graphify/validate-graphify.ps1.'
        }
    }

    $policyText = Read-ProjectText 'graphify.policy.json' $Source $Ref
    if ([string]::IsNullOrWhiteSpace($policyText)) {
        Write-Fail "graphify.policy.json is missing or empty in $Source; refusing to guess approval."
        return $null
    }

    try {
        $policy = $policyText | ConvertFrom-Json
    }
    catch {
        Write-Fail 'graphify.policy.json is not valid JSON.'
        return $null
    }

    if ($null -eq $policy) {
        Write-Fail 'graphify.policy.json produced no policy object.'
        return $null
    }

    try {
        if ([int]$policy.schemaVersion -lt 1) {
            Write-Fail 'graphify.policy.json: schemaVersion must be >= 1.'
        }
    }
    catch {
        Write-Fail 'graphify.policy.json: schemaVersion must be an integer.'
    }

    if ([string]$policy.tool -ne 'graphify') {
        Write-Fail "graphify.policy.json: tool must be 'graphify'."
    }

    foreach ($required in @('approval', 'source', 'revision', 'installation', 'graphifyDependentActions', 'protectedPaths', 'protectedFiles')) {
        if ($null -eq $policy.$required) {
            Write-Fail "graphify.policy.json: missing required object/array '$required'."
        }
    }

    $approved = $false
    if ($null -ne $policy.approval) { $approved = [bool]$policy.approval.approved }

    if ($approved) {
        if ([string]$policy.policyStatus -ne 'approved') {
            Write-Fail "graphify.policy.json: approved installation requires policyStatus='approved'."
        }
        if ([string]$policy.graphifyDependentActions -ne 'allowed') {
            Write-Fail "graphify.policy.json: approved installation requires graphifyDependentActions='allowed'."
        }
        if ([string]::IsNullOrWhiteSpace([string]$policy.approval.approvedBy)) {
            Write-Fail 'graphify.policy.json: approval.approvedBy is required when approved.'
        }
        if ([string]$policy.approval.approvedAt -notmatch '^\d{4}-\d{2}-\d{2}(T.*)?$') {
            Write-Fail 'graphify.policy.json: approval.approvedAt must be an ISO-8601 date.'
        }
        if (-not [bool]$policy.source.approved) {
            Write-Fail 'graphify.policy.json: source.approved must be true when installation is approved.'
        }
        if (@('pypi', 'git', 'local', 'archive') -notcontains [string]$policy.source.type) {
            Write-Fail "graphify.policy.json: source.type must be one of pypi, git, local, archive."
        }
        if ([string]::IsNullOrWhiteSpace([string]$policy.source.value)) {
            Write-Fail 'graphify.policy.json: source.value is required when approved.'
        }
        if (-not [bool]$policy.revision.approved -or [string]::IsNullOrWhiteSpace([string]$policy.revision.value)) {
            Write-Fail 'graphify.policy.json: an approved, non-empty revision.value is required when approved.'
        }
        if (-not [bool]$policy.installation.approved) {
            Write-Fail 'graphify.policy.json: installation.approved must be true when approved.'
        }
        if ([string]$policy.installation.state -ne 'installed') {
            Write-Fail "graphify.policy.json: approved installation requires installation.state='installed'."
        }
        if ([string]::IsNullOrWhiteSpace([string]$policy.installation.version)) {
            Write-Fail 'graphify.policy.json: installation.version is required when approved.'
        }
        if ([string]::IsNullOrWhiteSpace([string]$policy.installation.path)) {
            Write-Fail 'graphify.policy.json: installation.path is required when approved.'
        }
    }
    else {
        if ([string]$policy.policyStatus -ne 'not-approved') {
            Write-Fail "graphify.policy.json: unapproved policy requires policyStatus='not-approved'."
        }
        if ([string]$policy.graphifyDependentActions -ne 'blocked') {
            Write-Fail "graphify.policy.json: unapproved policy requires graphifyDependentActions='blocked'."
        }
        if ($null -ne $policy.approval.approvedBy -or $null -ne $policy.approval.approvedAt) {
            Write-Fail 'graphify.policy.json: do not record approver metadata while approval is false.'
        }
        if ([bool]$policy.source.approved -or $null -ne $policy.source.type -or $null -ne $policy.source.value) {
            Write-Fail 'graphify.policy.json: do not record an approved source while approval is false.'
        }
        if ([bool]$policy.revision.approved -or $null -ne $policy.revision.value) {
            Write-Fail 'graphify.policy.json: do not record an approved revision while approval is false.'
        }
        if ([bool]$policy.installation.approved) {
            Write-Fail 'graphify.policy.json: installation.approved must be false while approval is false.'
        }
        if ([string]$policy.installation.state -ne 'not_installed') {
            Write-Fail "graphify.policy.json: unapproved installation must record installation.state='not_installed'."
        }
        # This is the anti-fabrication gate: no version until an approved install exists.
        if ($null -ne $policy.installation.version -and -not [string]::IsNullOrWhiteSpace([string]$policy.installation.version)) {
            Write-Fail 'graphify.policy.json: installation.version must be null while installation is not approved.'
        }
        if ($null -ne $policy.installation.path) {
            Write-Fail 'graphify.policy.json: installation.path must be null while installation is not approved.'
        }
    }

    if ([string]$policy.installation.scope -ne 'project-local') {
        Write-Fail "graphify.policy.json: installation.scope must be 'project-local'."
    }

    foreach ($requiredPath in @('.claude/skills/graphify/', '.venv/', 'graphify-out/')) {
        $found = $false
        foreach ($candidate in @($policy.protectedPaths)) {
            if (([string]$candidate -replace '\\', '/') -eq $requiredPath) { $found = $true }
        }
        if (-not $found) {
            Write-Fail "graphify.policy.json: protectedPaths must include '$requiredPath'."
        }
    }

    if (@($policy.protectedFiles).Count -eq 0) {
        Write-Fail 'graphify.policy.json: protectedFiles must not be empty.'
    }

    # While Graphify is unapproved, active config must not silently re-enable it.
    if (-not $approved) {
        $settings = Read-ProjectText '.claude/settings.json' $Source $Ref
        if (-not [string]::IsNullOrWhiteSpace($settings) -and
            $settings -match '(?i)"command"\s*:\s*"[^"]*graphify') {
            Write-Fail 'Graphify is unapproved, but .claude/settings.json still contains a Graphify hook command.'
        }

        $opencode = Read-ProjectText 'opencode.json' $Source $Ref
        if (-not [string]::IsNullOrWhiteSpace($opencode) -and
            $opencode -match '(?i)graphifyy[^\r\n]*"\s*:\s*"allow"') {
            Write-Fail 'Graphify is unapproved, but opencode.json still contains a Graphify install allow rule.'
        }
    }

    if ($script:Failures.Count -ne $before) {
        return $null
    }

    $script:Policy = $policy
    return $policy
}

function Get-StagedEntries {
    $result = Invoke-GitText @('diff', '--cached', '--name-status', '--find-renames')
    if ($result.Code -ne 0) {
        Write-Fail 'Could not read the staged file list; refusing to commit unverified changes.'
        return @()
    }

    $entries = @()
    foreach ($line in $result.Output) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = $line -split "`t"
        if ($parts.Count -lt 2) { continue }
        $status = $parts[0]
        if ($status -like 'R*' -or $status -like 'C*') {
            if ($parts.Count -ge 3) {
                $entries += [pscustomobject]@{ Status = $status.Substring(0, 1); Path = $parts[2] }
            }
        }
        else {
            $entries += [pscustomobject]@{ Status = $status.Substring(0, 1); Path = $parts[1] }
        }
    }
    return $entries
}

function Test-StagedSafety {
    param([object[]]$Entries)

    # Credential shapes. These are literals in this file, not secrets; the patterns
    # match real values, not their own source text.
    $secretPatterns = @(
        '-----BEGIN (RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY',
        'AKIA[0-9A-Z]{16}',
        'ghp_[A-Za-z0-9]{36}',
        'github_pat_[A-Za-z0-9_]{20,}',
        'xox[baprs]-[A-Za-z0-9-]{10,}',
        'password\s*=\s*[''"]',
        'api[_-]?key\s*=\s*[''"]',
        'secret\s*=\s*[''"]'
    )

    $blockedExtensions = @(
        '.exe', '.dll', '.so', '.dylib', '.msi', '.msix', '.bin', '.iso', '.dmg',
        '.pkg', '.deb', '.rpm', '.jar', '.class', '.pyc', '.pyo', '.zip', '.7z',
        '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.cab', '.scr', '.com'
    )

    # Build Windows path patterns from a char code so this file never contains an
    # absolute path that its own out-of-project scan would flag. Escape each literal
    # backslash for the regex engine.
    $literalBackslash = [string][char]92
    $regexBackslash = [regex]::Escape($literalBackslash)
    $outsidePatterns = @(
        ('[A-Za-z]:' + $regexBackslash + '(?:Users|Windows|ProgramData|Program Files|Temp)' + $regexBackslash),
        ([regex]::Escape($literalBackslash + $literalBackslash) + '(?:Users|Windows)' + $regexBackslash),
        '(?:^|[\s"''=:(])/(?:etc|home|root|Users|var|usr|opt)/'
    )

    $diff = Invoke-GitText @('--no-pager', 'diff', '--cached', '-U0', '--no-color')
    if ($diff.Code -ne 0) {
        Write-Fail 'Could not read the staged diff; refusing to commit unverified changes.'
        return
    }

    $addedLines = @()
    foreach ($line in $diff.Output) {
        if ($line -match '^\+' -and $line -notmatch '^\+\+\+') {
            $addedLines += $line
        }
    }

    foreach ($line in $addedLines) {
        foreach ($pattern in $secretPatterns) {
            if ($line -match $pattern) {
                Write-Fail "Staged content matches a secret pattern ($pattern). Remove the value and rotate it; do not bypass."
                break
            }
        }
        foreach ($pattern in $outsidePatterns) {
            if ($line -match $pattern) {
                Write-Fail 'Staged content references a path outside the project folder (AGENTS.md section 0.1).'
                break
            }
        }
    }

    foreach ($entry in @($Entries)) {
        if ($null -eq $entry) { continue }
        if ($entry.Status -eq 'D') { continue }

        $path = [string]$entry.Path
        $normalized = ($path -replace '\\', '/')

        if ($normalized -match '(?i)(^|/)\.env($|\.)' -and $normalized -notmatch '(?i)(^|/)\.env\.example$') {
            Write-Fail "Staged secret file '$path' is not allowed."
        }
        if ($normalized -match '(?i)\.(pem|key|p12|pfx)$' -or
            $normalized -match '(?i)(^|/)id_(rsa|ed25519)(\.|$)') {
            Write-Fail "Staged credential-looking file '$path' is not allowed."
        }

        $extension = [System.IO.Path]::GetExtension($normalized).ToLowerInvariant()
        if ($blockedExtensions -contains $extension) {
            Write-Fail "Staged binary/archive '$path' is not approved for commit ($extension)."
        }

        $sizeResult = Invoke-GitText @('cat-file', '-s', ":$path")
        if ($sizeResult.Code -ne 0 -or @($sizeResult.Output).Count -eq 0) {
            Write-Fail "Could not read the staged size of '$path'; refusing to commit unverified content."
        }
        else {
            try {
                $size = [int64]([string]$sizeResult.Output[0]).Trim()
                if ($size -gt 1048576) {
                    Write-Fail "Staged file '$path' is $size bytes (> 1 MiB); commit large files only with explicit approval."
                }
            }
            catch {
                Write-Fail "Could not parse the staged size of '$path'; failing closed."
            }
        }
    }
}

function Get-CommitChangedPaths {
    param([string]$Commit)

    $rev = Invoke-GitText @('rev-list', '--parents', '-n', '1', $Commit)
    if ($rev.Code -ne 0 -or @($rev.Output).Count -eq 0) {
        Write-Fail "Could not inspect commit '$Commit'; refusing to push unverified history."
        return @()
    }

    $parts = ([string]$rev.Output[0]).Trim() -split '\s+'
    $parents = @($parts | Select-Object -Skip 1)
    $diffs = @()

    if ($parents.Count -eq 0) {
        $rootDiff = Invoke-GitText @('--no-pager', 'diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '--find-renames', $Commit)
        if ($rootDiff.Code -ne 0) {
            Write-Fail "Could not read the root commit '$Commit'; refusing to push unverified history."
            return @()
        }
        $diffs += @($rootDiff.Output)
    }
    else {
        foreach ($parent in $parents) {
            $parentDiff = Invoke-GitText @('--no-pager', 'diff', '--name-status', '--find-renames', $parent, $Commit)
            if ($parentDiff.Code -ne 0) {
                Write-Fail "Could not diff '$parent..$Commit'; refusing to push unverified history."
                return @()
            }
            $diffs += @($parentDiff.Output)
        }
    }

    $paths = @()
    foreach ($line in $diffs) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $fields = $line -split "`t"
        if ($fields.Count -lt 2) { continue }
        $status = $fields[0]
        if ($status -eq 'D') { continue }
        if (($status -like 'R*' -or $status -like 'C*') -and $fields.Count -ge 3) {
            $paths += $fields[2]
        }
        else {
            $paths += $fields[1]
        }
    }

    return @($paths | Sort-Object -Unique)
}

function Get-PushCommits {
    param(
        [string]$LocalSha,
        [string]$RemoteSha
    )

    if ($LocalSha -match '^0+$') { return @() }

    if ($RemoteSha -notmatch '^0+$') {
        $probe = Invoke-GitText @('cat-file', '-e', "$RemoteSha^{commit}")
        if ($probe.Code -eq 0) {
            $range = Invoke-GitText @('rev-list', "$RemoteSha..$LocalSha")
            if ($range.Code -eq 0) { return @($range.Output | Where-Object { $_ }) }
        }
        else {
            Write-Warn "remote base $RemoteSha is not present locally; checking local tracking refs only (no fetch)."
        }
    }

    $localOnly = Invoke-GitText @('rev-list', $LocalSha, '--not', '--remotes')
    if ($localOnly.Code -eq 0) {
        $commits = @($localOnly.Output | Where-Object { $_ })
        if ($commits.Count -gt 0) { return $commits }
    }

    Write-Warn "no local remote base for $LocalSha; checking the tip commit only (no fetch)."
    $tip = Invoke-GitText @('rev-list', '-1', $LocalSha)
    if ($tip.Code -eq 0) { return @($tip.Output | Where-Object { $_ }) }
    return @()
}

function Test-LocalHooksPath {
    param([bool]$Blocking)

    $config = Invoke-GitText @('config', '--local', '--get', 'core.hooksPath')
    $value = ''
    if ($config.Code -eq 0 -and @($config.Output).Count -gt 0) {
        $value = ([string]$config.Output[0]).Trim()
    }
    $normalized = ($value -replace '\\', '/').TrimEnd('/')

    if ($normalized -ne '.githooks') {
        $message = "repository-local core.hooksPath is '$value', not '.githooks'; run: git config --local core.hooksPath .githooks"
        if ($Blocking) { Write-Fail $message } else { Write-Warn $message }
        return $false
    }

    Write-Info 'repository-local hooks path: .githooks'
    return $true
}

function Get-PushApproval {
    $headResult = Invoke-GitText @('rev-parse', 'HEAD')
    if ($headResult.Code -ne 0 -or @($headResult.Output).Count -eq 0) {
        Write-Fail 'Could not resolve HEAD for push authorisation.'
        return
    }
    $head = ([string]$headResult.Output[0]).Trim()

    $gitDirResult = Invoke-GitText @('rev-parse', '--git-dir')
    if ($gitDirResult.Code -ne 0 -or @($gitDirResult.Output).Count -eq 0) {
        Write-Fail 'Could not resolve the Git directory for push authorisation.'
        return
    }
    $gitDir = ([string]$gitDirResult.Output[0]).Trim()
    if (-not [System.IO.Path]::IsPathRooted($gitDir)) {
        $gitDir = Join-Path $script:Root $gitDir
    }
    $gitDir = (Resolve-Path -LiteralPath $gitDir).Path
    $approvalFile = Join-Path $gitDir 'graphify-push-approved'

    if (-not (Test-Path -LiteralPath $approvalFile)) {
        Write-Fail "Explicit push authorisation is missing. No push was sent. Create '$approvalFile' containing the full HEAD SHA ($head) immediately before the approved push."
        return
    }

    $approvedSha = ''
    foreach ($line in (Get-Content -LiteralPath $approvalFile -ErrorAction Stop)) {
        if (-not [string]::IsNullOrWhiteSpace($line)) { $approvedSha = $line.Trim(); break }
    }

    if ($approvedSha -notmatch '^[0-9a-fA-F]{40,64}$') {
        Write-Fail "Push approval file does not contain a full commit SHA. Expected HEAD $head."
        return
    }
    if ($approvedSha -ne $head) {
        Write-Fail "Push approval is for $approvedSha, but HEAD is $head. Approve the current commit explicitly."
        return
    }

    Write-Info "explicit push authorisation present for HEAD $head"
}

function Show-SessionState {
    if ($null -eq $script:Policy) { return }

    $approved = [bool]$script:Policy.approval.approved
    if ($approved) {
        Write-Info ('policy: approved installation; version ' + [string]$script:Policy.installation.version)
    }
    else {
        Write-Info 'policy: not-approved; installation state recorded as not_installed (no version recorded)'
        Write-Info 'Graphify-dependent actions: BLOCKED until explicit human approval'
    }
    Write-Info 'unrelated safe work: allowed'

    $venvGraphify = Join-Path $script:Root '.venv\Scripts\graphify.exe'
    $venvPackage = Get-ChildItem -LiteralPath (Join-Path $script:Root '.venv\Lib\site-packages') -Filter 'graphifyy-*.dist-info' -Directory -ErrorAction SilentlyContinue
    if ((Test-Path -LiteralPath $venvGraphify) -or $venvPackage) {
        Write-Warn 'an unapproved local Graphify copy is present; the policy still records not_installed and this copy must not be used.'
    }
    else {
        Write-Info 'local Graphify copy: not present'
    }

    if (Test-Path -LiteralPath (Join-Path $script:Root 'graphify-out')) {
        Write-Warn 'graphify-out/ exists but is ignored by git; do not commit it and do not treat it as approved output.'
    }
}

function Complete-Run {
    if ($script:Failures.Count -gt 0) {
        Write-Host ''
        Write-Host "[graphify] validation FAILED ($($script:Failures.Count) issue(s))." -ForegroundColor Red
        exit 1
    }
    Write-Host "[graphify] validation passed ($Mode)." -ForegroundColor Green
    exit 0
}

# ---------------------------------------------------------------------------
# Mode dispatch
# ---------------------------------------------------------------------------

switch ($Mode) {
    'session' {
        $policy = Test-Policy 'worktree' ''
        if ($null -eq $policy) { Complete-Run }
        Test-LocalHooksPath $false | Out-Null
        Show-SessionState
        Complete-Run
    }

    'policy' {
        $policy = Test-Policy 'worktree' ''
        if ($null -eq $policy) { Complete-Run }
        Write-Info 'AGENTS.md section 6 and graphify.policy.json are consistent.'
        Complete-Run
    }

    'pre-commit' {
        $policy = Test-Policy 'index' ''
        if ($null -eq $policy) { Complete-Run }

        $entries = @(Get-StagedEntries)
        $approved = [bool]$policy.installation.approved

        foreach ($entry in $entries) {
            if ($null -eq $entry -or $entry.Status -eq 'D') { continue }
            if (Test-ProtectedPath ([string]$entry.Path)) {
                if (-not $approved) {
                    Write-Fail "staged Graphify-protected path '$($entry.Path)' requires an approved installation."
                }
            }
        }

        Test-StagedSafety $entries
        Complete-Run
    }

    'pre-push' {
        Test-LocalHooksPath $true | Out-Null

        if ([string]::IsNullOrWhiteSpace($PushRefsFile) -or -not (Test-Path -LiteralPath $PushRefsFile)) {
            Write-Fail 'Could not read the refs Git is about to push; refusing to push unverified history.'
            Complete-Run
        }

        $refLines = @(Get-Content -LiteralPath $PushRefsFile -ErrorAction Stop | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($refLines.Count -eq 0) {
            Write-Fail 'Git supplied no refs to verify; refusing to push.'
            Complete-Run
        }

        $checkedShas = @{}
        foreach ($line in $refLines) {
            $fields = $line.Trim() -split '\s+'
            if ($fields.Count -lt 4) {
                Write-Fail "Unrecognised pre-push ref line: '$line'."
                continue
            }
            $localSha = $fields[1]
            $remoteSha = $fields[3]
            if ($localSha -match '^0+$') { continue }

            if (-not $checkedShas.ContainsKey($localSha)) {
                $checkedShas[$localSha] = $true
                $policy = Test-Policy 'ref' $localSha
                if ($null -ne $policy) {
                    $approved = [bool]$policy.installation.approved
                    $commits = @(Get-PushCommits -LocalSha $localSha -RemoteSha $remoteSha)
                    foreach ($commit in $commits) {
                        foreach ($path in @(Get-CommitChangedPaths -Commit $commit)) {
                            if (Test-ProtectedPath ([string]$path) -and -not $approved) {
                                Write-Fail "commit $commit changes Graphify-protected path '$path' without an approved installation."
                            }
                        }
                    }
                }
            }
        }

        Get-PushApproval
        Complete-Run
    }
}
