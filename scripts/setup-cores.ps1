param([string]$DestinationRoot = '')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) { $DestinationRoot = $projectRoot }
$destination = if ([IO.Path]::IsPathRooted($DestinationRoot)) { [IO.Path]::GetFullPath($DestinationRoot) } else { [IO.Path]::GetFullPath((Join-Path $projectRoot $DestinationRoot)) }
if ($destination -ne $projectRoot -and -not $destination.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Destination must stay inside the project.' }
$downloadRoot = Join-Path $projectRoot '.local\downloads'
New-Item -ItemType Directory -Force -Path $downloadRoot | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Get-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose(); $stream.Dispose() }
}
function Get-VerifiedFile([string]$Url, [string]$Sha256, [string]$Name) {
    $file = Join-Path $downloadRoot $Name
    if (-not (Test-Path -LiteralPath $file) -or (Get-Sha256 $file) -ne $Sha256) {
        Invoke-WebRequest -Uri $Url -OutFile $file -UseBasicParsing
    }
    if ((Get-Sha256 $file) -ne $Sha256) { throw "SHA256 mismatch: $Name" }
    return $file
}
function Install-Core([string]$Folder, [string]$Url, [string]$Sha256, [string]$Executable, [string[]]$Files) {
    $target = Join-Path $destination $Folder
    $missing = @($Files | Where-Object { -not (Test-Path -LiteralPath (Join-Path $target $_)) })
    if ($missing.Count -eq 0) { Write-Output "Already present: $Folder"; return }
    $archive = Get-VerifiedFile $Url $Sha256 ($Folder + '.zip')
    $stage = Join-Path $downloadRoot ($Folder + '-' + [guid]::NewGuid().ToString('N'))
    Expand-Archive -LiteralPath $archive -DestinationPath $stage
    $binaries = @(Get-ChildItem -LiteralPath $stage -Recurse -File -Filter $Executable)
    if ($binaries.Count -ne 1) { throw "Unexpected archive layout: $Folder" }
    $source = $binaries[0].DirectoryName
    foreach ($name in $Files) {
        if (-not (Test-Path -LiteralPath (Join-Path $source $name))) { throw "Missing resource in archive: $name" }
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($name in $missing) { Copy-Item -LiteralPath (Join-Path $source $name) -Destination (Join-Path $target $name) }
    Write-Output "Installed: $Folder"
}

# Pinned official release archives, verified against GitHub release SHA256 digests.
Install-Core 'Xray-windows-64' 'https://github.com/XTLS/Xray-core/releases/download/v26.10.31/Xray-windows-64.zip' '2e04a9995a6f2ad1b28c0bb25c708ecb2695e43a1c9c7889c4b6ac2b48cf7a6a' 'xray.exe' @('xray.exe','geoip.dat','geosite.dat','wintun.dll','LICENSE','LICENSE-Wintun')
Install-Core 'sing-box-1.14.4-windows-amd64' 'https://github.com/SagerNet/sing-box/releases/download/v1.14.4/sing-box-1.14.4-windows-amd64.zip' '99185d75d314a07dbba4a130c8ad986cbeb629a07927975636b341ca61f991df' 'sing-box.exe' @('sing-box.exe','libcronet.dll','LICENSE')

$ruleRoot = Join-Path $destination 'assets\rules'
$tunRoot = Join-Path $destination 'assets\tun'
New-Item -ItemType Directory -Force -Path $ruleRoot,$tunRoot | Out-Null
$rules = @(
    @{Name='geosite-cn.srs'; Commit='cb97a51a731bbed53e6812598a28c2514268209f'; Hash='0b2bd0913d8cb36e18f464ffbbc7303a5a5c2f15e2d82a0ac36bd65966698b07'},
    @{Name='geoip-cn.srs'; Commit='cf747024a4e572ffe7f687d3432ed71f35576353'; Hash='2d717876d0b0e5af0d3451d6a48ff2d19729b11b7e7bfeb19fbee7bb4e7937ed'}
)
foreach ($rule in $rules) {
    $target = Join-Path $ruleRoot $rule.Name
    if (Test-Path -LiteralPath $target) { continue }
    $file = Get-VerifiedFile ("https://raw.githubusercontent.com/2dust/sing-box-rules/" + $rule.Commit + '/' + $rule.Name) $rule.Hash ($rule.Commit + '-' + $rule.Name)
    Copy-Item -LiteralPath $file -Destination $target
}
foreach ($name in @('wintun.dll','LICENSE-Wintun')) {
    Copy-Item -LiteralPath (Join-Path $destination ('Xray-windows-64\' + $name)) -Destination (Join-Path $tunRoot $name) -Force
}
Write-Output "Core and rule resources ready: $destination"
