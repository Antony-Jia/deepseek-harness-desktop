$ErrorActionPreference = 'Stop'

$probe = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-desktop-e1-' + [guid]::NewGuid().ToString('N'))
$stdoutPath = Join-Path $probe 'stdout.log'
$stderrPath = Join-Path $probe 'stderr.log'
$dshHome = Join-Path $probe 'dsh-home'
$process = $null

try {
    New-Item -ItemType Directory -Path $probe | Out-Null
    Write-Output "Installing isolated @deepseek-ai/dsh@0.1.0-rc.6 under $probe"
    & npm.cmd install --prefix $probe --no-audit --no-fund --loglevel=error '@deepseek-ai/dsh@0.1.0-rc.6'
    if ($LASTEXITCODE -ne 0) {
        throw "npm install exited with code $LASTEXITCODE"
    }

    $bin = Join-Path $probe 'node_modules\@deepseek-ai\dsh\lib\bin.js'
    if (!(Test-Path -LiteralPath $bin)) {
        throw "Missing installed DSH entrypoint: $bin"
    }

    $node = (Get-Command node.exe).Source
    $previousDshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
    $env:DSH_HOME = $dshHome
    $startParams = @{
        FilePath = $node
        ArgumentList = @($bin, 'web', '--host', '127.0.0.1', '--port', '0')
        WorkingDirectory = $probe
        RedirectStandardOutput = $stdoutPath
        RedirectStandardError = $stderrPath
        PassThru = $true
        WindowStyle = 'Hidden'
    }
    $process = Start-Process @startParams
    if ($null -eq $previousDshHome) {
        Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
    } else {
        $env:DSH_HOME = $previousDshHome
    }

    $url = $null
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        Start-Sleep -Milliseconds 500
        $combined = (
            (Get-Content -Raw -LiteralPath $stdoutPath -ErrorAction SilentlyContinue) +
            [Environment]::NewLine +
            (Get-Content -Raw -LiteralPath $stderrPath -ErrorAction SilentlyContinue)
        )
        $match = [regex]::Match($combined, 'http://127\.0\.0\.1:\d+')
        if ($match.Success) {
            $url = $match.Value
            try {
                $response = Invoke-WebRequest -Uri ($url + '/') -UseBasicParsing -TimeoutSec 3
                Write-Output "Healthy DSH URL: $url (HTTP $($response.StatusCode))"
                break
            } catch {
                # The listener can print its URL before the HTTP server is ready.
            }
        }
        if ($process.HasExited) {
            break
        }
    }

    if (!$url) {
        Write-Output '--- dsh stdout ---'
        Get-Content -Raw -LiteralPath $stdoutPath -ErrorAction SilentlyContinue
        Write-Output '--- dsh stderr ---'
        Get-Content -Raw -LiteralPath $stderrPath -ErrorAction SilentlyContinue
        throw 'DSH did not expose a healthy loopback URL within 90 seconds.'
    }
} finally {
    if ($process -and !$process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $probe) {
        Remove-Item -LiteralPath $probe -Recurse -Force -ErrorAction SilentlyContinue
    }
}
