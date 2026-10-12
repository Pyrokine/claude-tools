param(
    [ValidateRange(1, 65535)]
    [int]$Port = 9222,
    [string]$ExecutablePath,
    [string]$ProfileDir = (Join-Path $HOME '.mcp-chrome\profile')
)

$ErrorActionPreference = 'Stop'
if (-not $ExecutablePath) {
    $candidates = [System.Collections.Generic.List[string]]::new()
    foreach ($hive in @('HKCU:', 'HKLM:')) {
        foreach ($name in @('chrome.exe', 'chromium.exe')) {
            $key = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$name"
            foreach ($view in @('', '\WOW6432Node')) {
                $candidateKey = $key.Replace('\Microsoft\', "$view\Microsoft\")
                if (Test-Path -LiteralPath $candidateKey) {
                    $value = (Get-Item -LiteralPath $candidateKey).GetValue('')
                    if ($value) { $candidates.Add([Environment]::ExpandEnvironmentVariables($value)) }
                }
            }
        }
    }
    foreach ($folder in ($env:PATH -split ';')) {
        if ($folder) {
            foreach ($name in @('chrome.exe', 'chromium.exe')) {
                $candidates.Add((Join-Path $folder $name))
            }
        }
    }
    $channels = @(
        'Google\Chrome\Application\chrome.exe',
        'Google\Chrome Beta\Application\chrome.exe',
        'Google\Chrome Dev\Application\chrome.exe',
        'Google\Chrome SxS\Application\chrome.exe',
        'Chromium\Application\chrome.exe',
        'Google\Chrome for Testing\chrome-win64\chrome.exe',
        'Google\Chrome for Testing\chrome-win32\chrome.exe'
    )
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($root) {
            foreach ($channel in $channels) { $candidates.Add((Join-Path $root $channel)) }
        }
    }
    foreach ($root in @($env:MCP_CHROME_PORTABLE_DIR, (Join-Path $HOME '.mcp-chrome\portable'))) {
        if ($root) {
            foreach ($suffix in @('chrome.exe', 'chrome-win64\chrome.exe', 'chrome-win32\chrome.exe')) {
                $candidates.Add((Join-Path $root $suffix))
            }
        }
    }
    $ExecutablePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $ExecutablePath -or -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw 'Chrome/Chromium not found; pass -ExecutablePath or install Chrome'
}
New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null
& $ExecutablePath "--remote-debugging-port=$Port" '--remote-debugging-address=127.0.0.1' "--user-data-dir=$ProfileDir" '--no-first-run' '--no-default-browser-check' 'about:blank'
if ($LASTEXITCODE -ne 0) { throw "Chrome exited with code $LASTEXITCODE" }
