$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = if ($env:DSH_DESKTOP_EXE) { $env:DSH_DESKTOP_EXE } else { Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Set DSH_DESKTOP_EXE to the installed DeepSeek Harness executable.' }
$output = Join-Path $repo '.test-output'
New-Item -ItemType Directory -Path $output -Force | Out-Null
$stdout = Join-Path $output 'desktop-stdout.log'
$stderr = Join-Path $output 'desktop-stderr.log'
$saved = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  $script = Join-Path $repo 'tests\desktop-smoke.mjs'
  $p = Start-Process -FilePath $exe -ArgumentList @('--expose-internals', ('"' + $script + '"')) -WorkingDirectory $repo -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Get-Content -LiteralPath $stdout
  if ((Get-Item -LiteralPath $stderr).Length -gt 0) { Get-Content -LiteralPath $stderr }
  if ($p.ExitCode -ne 0) { throw "Desktop smoke test failed: exit $($p.ExitCode)" }
} finally {
  $env:ELECTRON_RUN_AS_NODE = $saved
}
