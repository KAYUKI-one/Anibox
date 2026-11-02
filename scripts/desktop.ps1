param([switch]$Build, [switch]$PackageOnly, [switch]$QA, [string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = if ($QA) { '.local\qa\Anibox' } else { 'release\Anibox' }
}
New-Item -ItemType Directory -Force -Path (Join-Path $projectRoot 'assets\tun') | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'Xray-windows-64\wintun.dll') -Destination (Join-Path $projectRoot 'assets\tun\wintun.dll') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'Xray-windows-64\LICENSE-Wintun') -Destination (Join-Path $projectRoot 'assets\tun\LICENSE-Wintun') -Force
$localCargo = Join-Path $projectRoot '.tooling\cargo'
if (Test-Path -LiteralPath (Join-Path $localCargo 'bin\cargo.exe')) {
    $env:CARGO_HOME = $localCargo
    $env:RUSTUP_HOME = Join-Path $projectRoot '.tooling\rustup'
    $env:PATH = "$localCargo\bin;$env:PATH"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust stable and Visual Studio C++ Build Tools are required. See README.md.'
}
if ($Build) {
    if (-not $PackageOnly) {
        if ($QA) {
            & npm.cmd run tauri -- build --no-bundle --config scripts/tauri.qa.conf.json
        } else {
            & npm.cmd run tauri -- build --no-bundle
        }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    $portableRoot = if ([IO.Path]::IsPathRooted($OutputDirectory)) { [IO.Path]::GetFullPath($OutputDirectory) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory)) }
    if (-not $portableRoot.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Output must stay inside the project directory.' }
    $existingExe = Join-Path $portableRoot 'Anibox.exe'
    if (Test-Path -LiteralPath $existingExe) {
        try {
            $probe = [IO.File]::Open($existingExe, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $probe.Dispose()
        } catch {
            throw "Anibox is running in $portableRoot. Exit it from the tray and run packaging again; no extra preview directory will be created."
        }
    }
    $destinationRoot = $portableRoot
    # Assemble the complete portable build before replacing the previous one.
    $portableRoot = Join-Path $projectRoot ('.local\packages\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot 'src-tauri\target\release\anibox.exe') -Destination (Join-Path $portableRoot 'Anibox.exe') -Force
    $config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $config.bundle.resources.PSObject.Properties) {
        $sourcePath = [IO.Path]::GetFullPath((Join-Path (Join-Path $projectRoot 'src-tauri') $entry.Name))
        $destinationPath = [IO.Path]::GetFullPath((Join-Path $portableRoot $entry.Value))
        if (-not $destinationPath.StartsWith($portableRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Resource destination is outside the portable directory.' }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationPath) | Out-Null
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    }
    foreach ($name in @('LICENSE','THIRD_PARTY.md')) {
        if (Test-Path -LiteralPath (Join-Path $projectRoot $name)) { Copy-Item -LiteralPath (Join-Path $projectRoot $name) -Destination $portableRoot -Force }
    }
    Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\QUICKSTART.zh-CN.md') -Destination (Join-Path $portableRoot 'README.md') -Force
    $version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $stream = [IO.File]::OpenRead((Join-Path $portableRoot 'Anibox.exe'))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $executableHash = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
    @{version=$version; identifier=$(if ($QA) {'io.anibox.qa'} else {$config.identifier}); builtAt=[DateTime]::UtcNow.ToString('o'); executableSha256=$executableHash} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $portableRoot 'build-info.json') -Encoding UTF8
    if (Test-Path -LiteralPath $destinationRoot) {
        $archiveRoot = Join-Path $projectRoot '.local\releases-archive'
        New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
        $archivePath = [IO.Path]::GetFullPath((Join-Path $archiveRoot ((Split-Path -Leaf $destinationRoot) + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))))
        if (-not $archivePath.StartsWith($archiveRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid archive path.' }
        Move-Item -LiteralPath $destinationRoot -Destination $archivePath
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destinationRoot) | Out-Null
    Move-Item -LiteralPath $portableRoot -Destination $destinationRoot
    Write-Output "Desktop build ready: $destinationRoot\Anibox.exe ($version)"
} else { & npm.cmd run tauri -- dev }
exit $LASTEXITCODE
