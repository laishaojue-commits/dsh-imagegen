param([string]$TargetDirectory = (Join-Path $env:USERPROFILE '.dsh\plugins\dsh-imagegen'))
$ErrorActionPreference = 'Stop'
$source = Split-Path -Parent $PSScriptRoot
$target = [IO.Path]::GetFullPath($TargetDirectory)
$manifest = Get-Content -LiteralPath (Join-Path $source 'package.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'dsh-imagegen') { throw 'Unexpected source package' }
$installed = Join-Path $target 'package.json'
if (-not (Test-Path -LiteralPath $installed)) { throw 'First install with dsh plugin add link:<checkout>. This script updates an existing installation only.' }
if ((Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json).name -ne 'dsh-imagegen') { throw 'Target is not a dsh-imagegen installation' }
if ([IO.Path]::GetFullPath($source) -eq $target) { throw 'Target already points at this checkout; no copy is needed' }
$backup = Join-Path (Split-Path -Parent $target) ('.backups\dsh-imagegen-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
$files = @('package.json') + @($manifest.files | ForEach-Object {
  $p = Join-Path $source $_
  if (Test-Path -LiteralPath $p -PathType Container) {
    Get-ChildItem -LiteralPath $p -Recurse -File | ForEach-Object { $_.FullName.Substring($source.Length + 1) }
  } else { $_ }
})
$changed = @()
try {
  foreach ($relative in $files | Select-Object -Unique) {
    $destination = [IO.Path]::GetFullPath((Join-Path $target $relative))
    if (-not $destination.StartsWith($target.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package file escapes target directory' }
    $original = Join-Path $backup $relative
    $existed = Test-Path -LiteralPath $destination -PathType Leaf
    if ($existed) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $original) -Force | Out-Null
      Copy-Item -LiteralPath $destination -Destination $original
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    $temporary = $destination + '.new-' + [Guid]::NewGuid().ToString('N')
    Copy-Item -LiteralPath (Join-Path $source $relative) -Destination $temporary
    Move-Item -LiteralPath $temporary -Destination $destination -Force
    $changed += [PSCustomObject]@{ Path = $destination; Original = $original; Existed = $existed }
  }
} catch {
  foreach ($file in $changed) {
    if ($file.Existed) { Copy-Item -LiteralPath $file.Original -Destination $file.Path -Force }
    else { Remove-Item -LiteralPath $file.Path }
  }
  throw
}
Write-Output "Installed dsh-imagegen $($manifest.version). Backup: $backup"
Write-Output 'No profile settings changed. No application was stopped. Restart DSH when ready to load the update.'
