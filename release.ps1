#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build and publish a new Autoflow release locally (no GitHub Actions needed).

.DESCRIPTION
    1. Bumps version in package.json, Cargo.toml, and tauri.conf.json
    2. Builds the Tauri app (release profile) with updater signing
    3. Creates NSIS and MSI update bundles (.nsis.zip / .msi.zip) and signs them
    4. Generates latest.json for the auto-updater endpoint
    5. Creates a GitHub release and uploads all artifacts
    6. Commits the version bump, tags it, and pushes

.PREREQUISITES
    - Private key:  $env:USERPROFILE\.tauri\autoflow.key
    - Key password: $env:USERPROFILE\.tauri\autoflow.key.password  (plain text, one line)
      If the file does not exist you will be prompted instead.
    - gh CLI authenticated (run: gh auth login)

.EXAMPLE
    .\release.ps1 0.6.0
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Version
)

$ErrorActionPreference = 'Stop'

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "   OK: $msg" -ForegroundColor Green }
function Write-Fail([string]$msg) { Write-Host "   FAIL: $msg" -ForegroundColor Red; exit 1 }

function Set-FileUtf8NoBom([string]$path, [string]$content) {
    [System.IO.File]::WriteAllText(
        $path,
        $content,
        [System.Text.UTF8Encoding]::new($false)
    )
}

function New-StoredZip([string]$sourcePath, [string]$destZip) {
    Add-Type -AssemblyName 'System.IO.Compression'
    Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
    if (Test-Path $destZip) { Remove-Item $destZip -Force }
    $mode    = [System.IO.Compression.ZipArchiveMode]::Create
    $noComp  = [System.IO.Compression.CompressionLevel]::NoCompression
    $zip     = [System.IO.Compression.ZipFile]::Open($destZip, $mode)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $sourcePath,
        [System.IO.Path]::GetFileName($sourcePath),
        $noComp
    )
    $zip.Dispose()
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────

Write-Step "Pre-flight checks"

if (-not ($Version -match '^\d+\.\d+\.\d+$')) {
    Write-Fail "Version must be X.Y.Z (e.g. 0.6.0). Got: $Version"
}

$keyFile = "$env:USERPROFILE\.tauri\autoflow.key"
if (-not (Test-Path $keyFile)) {
    Write-Fail "Signing key not found at $keyFile"
}

$pwFile = "$env:USERPROFILE\.tauri\autoflow.key.password"
if (Test-Path $pwFile) {
    $keyPassword = (Get-Content $pwFile -Raw).Trim()
    Write-Ok "Key password loaded from file"
} else {
    $secure = Read-Host "Key password (Enter if none)" -AsSecureString
    $keyPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
    Write-Ok "Key password entered interactively"
}

$null = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) { Write-Fail "gh CLI not authenticated. Run: gh auth login" }

$repoSlug = (git remote get-url origin) -replace '.*github\.com[:/](.+?)(?:\.git)?$', '$1'
Write-Ok "Repo: $repoSlug"
Write-Ok "Version: $Version"

# ── Bump versions ─────────────────────────────────────────────────────────────

Write-Step "Bumping version to $Version"

$root = $PSScriptRoot

$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$pkg.version = $Version
Set-FileUtf8NoBom "$root\package.json" ($pkg | ConvertTo-Json -Depth 10)
Write-Ok "package.json"

$cargo = Get-Content "$root\src-tauri\Cargo.toml" -Raw
$cargo = $cargo -replace '(?m)^version\s*=\s*"[^"]+"', "version = `"$Version`""
Set-FileUtf8NoBom "$root\src-tauri\Cargo.toml" $cargo
Write-Ok "src-tauri/Cargo.toml"

$tauriConf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
$tauriConf.version = $Version
Set-FileUtf8NoBom "$root\src-tauri\tauri.conf.json" ($tauriConf | ConvertTo-Json -Depth 10)
Write-Ok "src-tauri/tauri.conf.json"

# ── Build ─────────────────────────────────────────────────────────────────────

Write-Step "Building Autoflow $Version (release profile - this takes a few minutes)"

$env:TAURI_SIGNING_PRIVATE_KEY          = $keyFile
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $keyPassword

Set-Location $root
npm run tauri build
if ($LASTEXITCODE -ne 0) { Write-Fail "tauri build failed" }
Write-Ok "Build complete"

# ── Locate bundle artifacts ───────────────────────────────────────────────────

Write-Step "Locating build artifacts"

$bundleDir = "$root\src-tauri\target\release\bundle"

$nsisExe = Get-ChildItem "$bundleDir\nsis" -Filter "Autoflow_${Version}_*-setup.exe" -File | Select-Object -First 1
if (-not $nsisExe) { Write-Fail "NSIS installer not found in $bundleDir\nsis" }
Write-Ok "NSIS: $($nsisExe.Name)"

$msiFile = Get-ChildItem "$bundleDir\msi" -Filter "Autoflow_${Version}_*.msi" -File | Select-Object -First 1
if (-not $msiFile) { Write-Fail "MSI not found in $bundleDir\msi" }
Write-Ok "MSI:  $($msiFile.Name)"

# ── Create STORED zips + sign ─────────────────────────────────────────────────

Write-Step "Creating updater bundles and signing"

$nsisZip = Join-Path $nsisExe.DirectoryName "$($nsisExe.BaseName).nsis.zip"
New-StoredZip $nsisExe.FullName $nsisZip
Write-Ok "Created $([System.IO.Path]::GetFileName($nsisZip))"

npx tauri signer sign --private-key-path $keyFile --password $keyPassword $nsisZip
if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to sign NSIS zip" }
$nsisSig = (Get-Content "$nsisZip.sig" -Raw).Trim()
Write-Ok "Signed NSIS zip"

$msiZip = Join-Path $msiFile.DirectoryName "$($msiFile.BaseName).msi.zip"
New-StoredZip $msiFile.FullName $msiZip
Write-Ok "Created $([System.IO.Path]::GetFileName($msiZip))"

npx tauri signer sign --private-key-path $keyFile --password $keyPassword $msiZip
if ($LASTEXITCODE -ne 0) { Write-Fail "Failed to sign MSI zip" }
Write-Ok "Signed MSI zip"

# ── latest.json ───────────────────────────────────────────────────────────────

Write-Step "Generating latest.json"

$tag  = "v$Version"
$base = "https://github.com/$repoSlug/releases/download/$tag"

$manifest = [ordered]@{
    version  = $Version
    notes    = "See the release page for changes."
    pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $nsisSig
            url       = "$base/$([System.IO.Path]::GetFileName($nsisZip))"
        }
    }
}

$latestJson = "$bundleDir\latest.json"
Set-FileUtf8NoBom $latestJson ($manifest | ConvertTo-Json -Depth 6)
Write-Ok "latest.json written"

# ── Git commit + tag ──────────────────────────────────────────────────────────

Write-Step "Committing version bump and creating tag $tag"

git add package.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json
git commit -m "Release $tag"
Write-Ok "Committed"

git tag $tag
Write-Ok "Tagged $tag"

git push
git push origin $tag
Write-Ok "Pushed commit and tag"

# ── GitHub release ────────────────────────────────────────────────────────────

Write-Step "Creating GitHub release $tag"

$releaseBody = @"
## Install

Download ``Autoflow_${Version}_x64-setup.exe`` (recommended) or ``Autoflow_${Version}_x64_en-US.msi``.

## Auto-update

Existing installations will pick this up automatically via the in-app update checker.
"@

gh release create $tag `
    --title "Autoflow $tag" `
    --notes $releaseBody `
    "$($nsisExe.FullName)" `
    "$($nsisExe.FullName).sig" `
    "$nsisZip" `
    "$nsisZip.sig" `
    "$($msiFile.FullName)" `
    "$($msiFile.FullName).sig" `
    "$msiZip" `
    "$msiZip.sig" `
    "$latestJson"

if ($LASTEXITCODE -ne 0) { Write-Fail "gh release create failed" }

Write-Host "`nAutoflow $tag released!" -ForegroundColor Green
Write-Host "https://github.com/$repoSlug/releases/tag/$tag" -ForegroundColor DarkCyan
