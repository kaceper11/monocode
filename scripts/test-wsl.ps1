param([Parameter(Mandatory = $true)][string]$Distribution)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($env:OS -ne "Windows_NT") { throw "Run this acceptance command on Windows with WSL2." }
Push-Location (Split-Path $PSScriptRoot -Parent)
$previousDistro = $env:MONOCODE_TEST_WSL_DISTRO
try {
    & wsl.exe --distribution $Distribution --exec /usr/bin/python3 -c "import os,sys; assert sys.version_info >= (3,9); assert hasattr(os,'pidfd_open'), 'WSL2 pidfd support is required'; fd=os.pidfd_open(os.getpid()); os.close(fd)"
    if ($LASTEXITCODE -ne 0) { throw "The selected distro needs Python 3.9+ and WSL2 process support." }
    $testPath = Join-Path $PSScriptRoot "test-wsl-bridge.py"
    $guestPath = & wsl.exe --distribution $Distribution --exec wslpath -u -- $testPath
    if ($LASTEXITCODE -ne 0) { throw "Could not locate the guest regression script." }
    & wsl.exe --distribution $Distribution --exec /usr/bin/python3 ($guestPath.Trim())
    if ($LASTEXITCODE -ne 0) { throw "Guest discovery regressions failed." }
    $env:MONOCODE_TEST_WSL_DISTRO = $Distribution
    & cargo test live_wsl_acceptance -- --ignored --nocapture --test-threads=1
    if ($LASTEXITCODE -ne 0) { throw "Real Windows/WSL acceptance failed." }
    Write-Host "Bridge, guest process, loopback HTTP/SSE and cleanup checks passed. Complete the app/provider checklist in docs/WSL_ACCEPTANCE.md."
} finally {
    $env:MONOCODE_TEST_WSL_DISTRO = $previousDistro
    Pop-Location
}
