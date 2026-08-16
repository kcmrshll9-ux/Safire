#requires -Version 7.0

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repository = 'kcmrshll9-ux/Safire'
$tag = 'v1.4.2'
$version = $tag.TrimStart('v')
$releaseDate = '2026-08-16'
$title = "Safire $version"
$notes = @'
Safire 1.4.2 is the first MIT-licensed Safire binary release.

## Highlights

- Licensed Safire under the standard MIT License.
- Aligned package metadata, contribution terms, public documentation, and press materials with the open-source license.
- Preserved separate protection for the Safire name and marks.
- Standardized Windows asset filenames for reliable downloads and checksum verification.

## Download for Windows

- **Safire-Setup-1.4.2.exe** — recommended installer for most users.
- **Safire-Portable-1.4.2.exe** — portable application with no installation required.
- **Safire-1.4.2-checksums.txt** — SHA-256 verification manifest.

> [!IMPORTANT]
> These executables are not code-signed. Windows SmartScreen may show a warning. Download Safire only from this official GitHub release.

## More information

- [MIT License](https://github.com/kcmrshll9-ux/Safire/blob/v1.4.2/LICENSE)
- [Full changes since 1.4.1](https://github.com/kcmrshll9-ux/Safire/compare/v1.4.1...v1.4.2)
'@

function Invoke-Checked {
  param(
    [Parameter(Mandatory)]
    [string]$FilePath,

    [string[]]$ArgumentList = @()
  )

  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Captured {
  param(
    [Parameter(Mandatory)]
    [string]$FilePath,

    [string[]]$ArgumentList = @()
  )

  $output = @(& $FilePath @ArgumentList)
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath failed with exit code $LASTEXITCODE."
  }
  return $output
}

function Assert-CleanRepository {
  $statusLines = @(Invoke-Captured -FilePath 'git' -ArgumentList @('status', '--porcelain=v1', '--untracked-files=all'))
  if ($statusLines.Count -ne 0) {
    throw 'The release checkout must contain no tracked, staged, or untracked source changes.'
  }
}

function Assert-NoExistingRelease {
  $probeOutput = @(& gh api "repos/$repository/releases/tags/$tag" 2>&1)
  $probeStatus = $LASTEXITCODE
  if ($probeStatus -eq 0) {
    throw "GitHub Release $tag already exists. Refusing to replace or mix published assets."
  }
  $probeText = $probeOutput -join "`n"
  if ($probeStatus -ne 1 -or $probeText -notmatch '(?i)(HTTP 404|not found)') {
    throw "Unable to determine whether GitHub Release $tag already exists."
  }
}

function Assert-ReleaseAssets {
  param(
    [Parameter(Mandatory)]
    [string[]]$LocalPaths
  )

  $releaseJson = (Invoke-Captured -FilePath 'gh' -ArgumentList @(
    'release', 'view', $tag,
    '--repo', $repository,
    '--json', 'assets,isDraft,isPrerelease,tagName'
  )) -join "`n"
  $release = $releaseJson | ConvertFrom-Json
  if ($release.tagName -ne $tag -or $release.isDraft -or $release.isPrerelease) {
    throw "GitHub Release $tag is not a published stable release."
  }

  $expectedNames = @($LocalPaths | ForEach-Object { Split-Path -Leaf $_ } | Sort-Object)
  $actualNames = @($release.assets | ForEach-Object { $_.name } | Sort-Object)
  if (($expectedNames -join "`n") -ne ($actualNames -join "`n")) {
    throw "GitHub Release $tag has an unexpected asset set."
  }

  $verificationDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "safire-release-verification-$([guid]::NewGuid().ToString('N'))"
  [void](New-Item -ItemType Directory -Path $verificationDirectory)
  try {
    foreach ($localPath in $LocalPaths) {
      $assetName = Split-Path -Leaf $localPath
      Invoke-Checked -FilePath 'gh' -ArgumentList @(
        'release', 'download', $tag,
        '--repo', $repository,
        '--pattern', $assetName,
        '--dir', $verificationDirectory
      )
      $downloadedPath = Join-Path $verificationDirectory $assetName
      if (-not (Test-Path -LiteralPath $downloadedPath -PathType Leaf)) {
        throw "Downloaded release asset is missing: $assetName"
      }
      $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $localPath).Hash
      $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadedPath).Hash
      if ($localHash -ne $downloadedHash) {
        throw "Published release asset failed SHA-256 verification: $assetName"
      }
    }
  } finally {
    if (Test-Path -LiteralPath $verificationDirectory) {
      Remove-Item -LiteralPath $verificationDirectory -Recurse -Force
    }
  }
}

if ($env:OS -ne 'Windows_NT') {
  throw 'Safire Windows releases must be built and published from Windows.'
}

foreach ($commandName in @('git', 'node', 'npm', 'gh')) {
  if (-not (Get-Command $commandName -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $commandName"
  }
}

$nodeVersionText = ([string](Invoke-Captured -FilePath 'node' -ArgumentList @('--version') | Select-Object -Last 1)).Trim().TrimStart('v')
try {
  $nodeVersion = [version]$nodeVersionText
} catch {
  throw 'Unable to parse the installed Node.js version.'
}
if ($nodeVersion -lt [version]'22.19.0') {
  throw "Node.js 22.19.0 or later is required; found $nodeVersionText."
}

$repositoryRoot = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-parse', '--show-toplevel') | Select-Object -Last 1)).Trim()
Set-Location -LiteralPath $repositoryRoot

$allowedOriginUrls = @(
  "https://github.com/$repository.git"
  "git@github.com:$repository.git"
  "ssh://git@github.com/$repository.git"
)
$originFetchUrl = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('remote', 'get-url', 'origin') | Select-Object -Last 1)).Trim()
$originPushUrl = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('remote', 'get-url', '--push', 'origin') | Select-Object -Last 1)).Trim()
if ($allowedOriginUrls -notcontains $originFetchUrl -or $allowedOriginUrls -notcontains $originPushUrl) {
  throw 'origin must use a canonical fetch and push URL for kcmrshll9-ux/Safire.'
}

$currentBranch = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('branch', '--show-current') | Select-Object -Last 1)).Trim()
if ($currentBranch -ne 'main') {
  $displayBranch = if ($currentBranch) { $currentBranch } else { 'a detached HEAD' }
  throw "Release from main, not '$displayBranch'."
}
Assert-CleanRepository

& gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub CLI is not authenticated for github.com.'
}
& gh repo view $repository --json nameWithOwner *> $null
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI cannot access $repository."
}
Assert-NoExistingRelease

Write-Host '[info] Fetching origin/main'
Invoke-Checked -FilePath 'git' -ArgumentList @('fetch', '--quiet', 'origin', 'main')
$currentCommit = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-parse', 'HEAD') | Select-Object -Last 1)).Trim()
$remoteCommit = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-parse', 'origin/main') | Select-Object -Last 1)).Trim()
if ($currentCommit -ne $remoteCommit) {
  throw 'Local main is not synchronized with origin/main.'
}

$packageJson = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json -AsHashtable
$packageLock = Get-Content -Raw -LiteralPath 'package-lock.json' | ConvertFrom-Json -AsHashtable
foreach ($declaredVersion in @($packageJson['version'], $packageLock['version'], $packageLock['packages']['']['version'])) {
  if ($declaredVersion -ne $version) {
    throw "Release metadata is not consistently versioned as $version."
  }
}
foreach ($declaredLicense in @($packageJson['license'], $packageLock['packages']['']['license'])) {
  if ($declaredLicense -ne 'MIT') {
    throw 'Release metadata is not consistently licensed as MIT.'
  }
}
$licenseText = Get-Content -Raw -LiteralPath 'LICENSE'
if ($licenseText -notmatch '^MIT License\r?\n\r?\nCopyright \(c\) 2026 Safire\r?\n') {
  throw 'LICENSE does not contain the expected MIT License notice.'
}
if (-not (Select-String -Quiet -LiteralPath 'CHANGELOG.md' -Pattern "^## \[$([regex]::Escape($version))\] - $releaseDate$")) {
  throw "CHANGELOG.md does not contain the expected $version release heading and date."
}

$releaseDirectory = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot 'release'))
$artifacts = @(
  Join-Path $releaseDirectory "Safire-Setup-$version.exe"
  Join-Path $releaseDirectory "Safire-Portable-$version.exe"
)
$checksumPath = Join-Path $releaseDirectory "Safire-$version-checksums.txt"
$generatedOutputs = @($artifacts) + @(
  $checksumPath
  (Join-Path $releaseDirectory "Safire-Setup-$version.exe.blockmap")
  (Join-Path $releaseDirectory 'latest.yml')
  (Join-Path $releaseDirectory 'win-unpacked')
)
$releasePrefix = $releaseDirectory + [System.IO.Path]::DirectorySeparatorChar
foreach ($outputPath in $generatedOutputs) {
  $fullOutputPath = [System.IO.Path]::GetFullPath($outputPath)
  if (-not $fullOutputPath.StartsWith($releasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Generated release output resolved outside the release directory.'
  }
  if (Test-Path -LiteralPath $fullOutputPath) {
    Remove-Item -LiteralPath $fullOutputPath -Recurse -Force
  }
}

Write-Host '[info] Installing locked dependencies'
Invoke-Checked -FilePath 'npm' -ArgumentList @('ci')

Write-Host '[info] Auditing production and development dependencies'
Invoke-Checked -FilePath 'npm' -ArgumentList @('audit', '--audit-level=high')

Write-Host '[info] Running type checks, tests, and the renderer build'
Invoke-Checked -FilePath 'npm' -ArgumentList @('run', 'check')

Write-Host '[info] Building the Windows installer and portable executable'
Invoke-Checked -FilePath 'npm' -ArgumentList @('run', 'dist:all')

$packagedLauncher = Join-Path $releaseDirectory 'win-unpacked\resources\safire-memory-mcp.cmd'
$packagedApp = Join-Path $releaseDirectory 'win-unpacked\Safire.exe'
if (-not (Test-Path -LiteralPath $packagedLauncher -PathType Leaf) -or -not (Test-Path -LiteralPath $packagedApp -PathType Leaf)) {
  throw 'Packaged acceptance-test entry points are missing.'
}

Write-Host '[info] Verifying the packaged memory runtime'
$previousPackagedLauncher = $env:SAFIRE_PACKAGED_MEMORY_LAUNCHER
try {
  $env:SAFIRE_PACKAGED_MEMORY_LAUNCHER = $packagedLauncher
  Invoke-Checked -FilePath 'node' -ArgumentList @('--test', 'test/memory-packaging.test.mjs')
} finally {
  if ($null -eq $previousPackagedLauncher) {
    Remove-Item Env:SAFIRE_PACKAGED_MEMORY_LAUNCHER -ErrorAction SilentlyContinue
  } else {
    $env:SAFIRE_PACKAGED_MEMORY_LAUNCHER = $previousPackagedLauncher
  }
}

Write-Host '[info] Verifying packaged Chromium renderer isolation'
$previousPackagedApp = $env:SAFIRE_PACKAGED_APP
try {
  $env:SAFIRE_PACKAGED_APP = $packagedApp
  Invoke-Checked -FilePath 'node' -ArgumentList @('test-support/packaged-renderer-security.mjs')
} finally {
  if ($null -eq $previousPackagedApp) {
    Remove-Item Env:SAFIRE_PACKAGED_APP -ErrorAction SilentlyContinue
  } else {
    $env:SAFIRE_PACKAGED_APP = $previousPackagedApp
  }
}

foreach ($artifact in $artifacts) {
  $artifactItem = Get-Item -LiteralPath $artifact
  if ($artifactItem.Length -eq 0) {
    throw "Expected artifact is empty: $($artifactItem.Name)"
  }
  if ($artifactItem.VersionInfo.ProductVersion -notmatch "^$([regex]::Escape($version))(?:\.0)?$" -or
      $artifactItem.VersionInfo.FileVersion -notmatch "^$([regex]::Escape($version))(?:\.0)?$") {
    throw "Artifact version metadata does not match ${version}: $($artifactItem.Name)"
  }
}

$checksumLines = foreach ($artifact in $artifacts) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash
  "$hash *$(Split-Path -Leaf $artifact)"
}
Set-Content -LiteralPath $checksumPath -Value $checksumLines -Encoding utf8
$uploads = @($artifacts) + @($checksumPath)

Assert-CleanRepository
if (([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-parse', 'HEAD') | Select-Object -Last 1)).Trim() -ne $currentCommit) {
  throw 'HEAD changed during the release build.'
}
Invoke-Checked -FilePath 'git' -ArgumentList @('fetch', '--quiet', 'origin', 'main')
$remoteCommitAfterBuild = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-parse', 'origin/main') | Select-Object -Last 1)).Trim()
if ($remoteCommitAfterBuild -ne $currentCommit) {
  throw 'origin/main changed during the release build.'
}
Assert-NoExistingRelease

$directRef = "refs/tags/$tag"
$peeledRef = "${directRef}^{}"
$remoteTagLines = @(Invoke-Captured -FilePath 'git' -ArgumentList @('ls-remote', '--tags', 'origin', $directRef, $peeledRef))
$remoteTagCommit = $null
foreach ($line in $remoteTagLines) {
  $parts = $line -split '\s+'
  if ($parts.Count -ge 2 -and $parts[1] -eq $peeledRef) {
    $remoteTagCommit = $parts[0]
    break
  }
}
if (-not $remoteTagCommit) {
  foreach ($line in $remoteTagLines) {
    $parts = $line -split '\s+'
    if ($parts.Count -ge 2 -and $parts[1] -eq $directRef) {
      $remoteTagCommit = $parts[0]
      break
    }
  }
}
if ($remoteTagCommit -and $remoteTagCommit -ne $currentCommit) {
  throw "Remote $tag points to a different commit."
}

& git show-ref --verify --quiet $directRef
$localTagStatus = $LASTEXITCODE
if ($localTagStatus -eq 0) {
  $localTagCommit = ([string](Invoke-Captured -FilePath 'git' -ArgumentList @('rev-list', '-n', '1', $tag) | Select-Object -Last 1)).Trim()
  if ($localTagCommit -ne $currentCommit) {
    throw "Local $tag points to a different commit."
  }
} elseif ($localTagStatus -eq 1) {
  Write-Host "[info] Creating annotated tag $tag at $currentCommit"
  Invoke-Checked -FilePath 'git' -ArgumentList @('tag', '-a', $tag, $currentCommit, '-m', $title)
} else {
  throw "Unable to inspect local tag $tag."
}

if (-not $remoteTagCommit) {
  Write-Host "[info] Pushing $tag"
  Invoke-Checked -FilePath 'git' -ArgumentList @('push', 'origin', $directRef)
} else {
  Write-Host "[info] Remote tag $tag already points to the release commit"
}

Write-Host '[info] Publishing the GitHub Release with verified Windows artifacts'
$createArguments = @('release', 'create', $tag) + $uploads + @(
  '--repo', $repository,
  '--verify-tag',
  '--title', $title,
  '--notes', $notes
)
Invoke-Checked -FilePath 'gh' -ArgumentList $createArguments
Assert-ReleaseAssets -LocalPaths $uploads

Write-Host "[info] Published and verified $title"
