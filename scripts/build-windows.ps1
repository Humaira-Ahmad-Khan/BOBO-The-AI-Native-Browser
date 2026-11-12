param([switch]$NoOpenFolder)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $repo 'out-offline-runtime'
$forge = Join-Path $repo 'node_modules\.bin\electron-forge.cmd'
$electronPackage = Join-Path $repo 'node_modules\electron\package.json'
if (!(Test-Path -LiteralPath $forge) -or !(Test-Path -LiteralPath $electronPackage)) {
    throw 'Install the project dependencies manually before building.'
}
$electronVersion = (Get-Content -LiteralPath $electronPackage -Raw | ConvertFrom-Json).version
$electronZip = Join-Path $runtime "electron-v$electronVersion-win32-x64.zip"
if (!(Test-Path -LiteralPath $electronZip)) {
    throw "The local Electron ZIP is missing. Expected $electronZip"
}

$oldLocation = Get-Location
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldZipDir = $env:BOBO_ELECTRON_ZIP_DIR
$drive = $null

try {
    Set-Location -LiteralPath $repo
    $env:BOBO_ELECTRON_ZIP_DIR = $runtime
    $env:TEMP = $runtime
    $env:TMP = $runtime
    & $forge package --platform win32 --arch x64
    if ($LASTEXITCODE -ne 0) { throw 'BOBO packaging failed.' }
    & node (Join-Path $repo 'scripts\verify-windows-package.js')
    if ($LASTEXITCODE -ne 0) { throw 'The packaged application does not match the current sources.' }

    # Squirrel's resource editor needs a path without Unicode characters.
    $letter = 'Q', 'R', 'V', 'W' | Where-Object {
        !(Get-PSDrive -Name $_ -ErrorAction SilentlyContinue) -and
        !(Test-Path ('{0}:\' -f $_))
    } | Select-Object -First 1
    if (!$letter) { throw 'No free temporary drive letter.' }
    $alias = "${letter}:"
    & subst.exe $alias $repo
    if ($LASTEXITCODE -ne 0) { throw 'Could not map the temporary build drive.' }
    $drive = $alias

    Set-Location "$drive\"
    $env:TEMP = "$drive\out-offline-runtime"
    $env:TMP = $env:TEMP
    & .\node_modules\.bin\electron-forge.cmd make --skip-package --targets '@electron-forge/maker-squirrel' --platform win32 --arch x64
    if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }

    $output = Join-Path $repo 'out\make\squirrel.windows\x64'
    $installer = Join-Path $output 'BOBO-Setup.exe'
    if (!(Test-Path -LiteralPath $installer)) { throw 'BOBO-Setup.exe was not created.' }
    $release = (Get-Content -LiteralPath (Join-Path $output 'RELEASES') -Raw).Trim() -split '\s+'
    $version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    $package = Get-Item -LiteralPath (Join-Path $output "bobo-$version-full.nupkg")
    if ($release[1] -ne $package.Name -or [long]$release[2] -ne $package.Length -or
        $release[0] -ne (Get-FileHash -LiteralPath $package.FullName -Algorithm SHA1).Hash) {
        throw 'The installer package does not match RELEASES.'
    }
    & node (Join-Path $repo 'scripts\verify-windows-package.js')
    if ($LASTEXITCODE -ne 0) { throw 'Sources changed during the build. Rebuild before installing.' }
    $versionedInstaller = Join-Path $output "BOBO-Setup-$version.exe"
    Copy-Item -LiteralPath $installer -Destination $versionedInstaller -Force
    Write-Host "Installer created at $versionedInstaller"
    Write-Host "After installing, Settings > About BOBO must show Version $version."
}
finally {
    Set-Location -LiteralPath $oldLocation.Path
    if ($drive) { & subst.exe $drive /D }
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    $env:BOBO_ELECTRON_ZIP_DIR = $oldZipDir
}

if (!$NoOpenFolder) { Invoke-Item -LiteralPath $output }
