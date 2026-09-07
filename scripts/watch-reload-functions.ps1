# Shared by the watcher and its process-isolation tests. Dot-sourcing has no side effects.
function Get-RedlineChromeProcess {
  param([object[]]$Processes, [string]$ProfileDir)
  $expected = [IO.Path]::GetFullPath($ProfileDir).TrimEnd([char[]]'\/')
  $pattern = '(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+)|--user-data-dir\s+"([^"]+)"|--user-data-dir\s+([^\s"]+))(?=\s|$)'
  foreach ($browser in $Processes) {
    if ($browser.Name -ne 'chrome.exe' -or -not $browser.CommandLine) { continue }
    $match = [regex]::Match($browser.CommandLine, $pattern, 'IgnoreCase')
    if (-not $match.Success) { continue }
    $candidate = ($match.Groups | Select-Object -Skip 1 | Where-Object Success | Select-Object -First 1).Value
    try { $candidate = [IO.Path]::GetFullPath($candidate).TrimEnd([char[]]'\/') } catch { continue }
    if ($candidate.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { $browser }
  }
}

function Restart-RedlineChrome {
  param([string]$ChromePath, [string]$RepoRoot, [string]$ProfileDir)
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue)
  foreach ($browser in @(Get-RedlineChromeProcess -Processes $processes -ProfileDir $ProfileDir)) {
    Stop-Process -Id $browser.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $browser.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
  }
  $arguments = @(
    ('--user-data-dir="{0}"' -f $ProfileDir),
    '--new-window',
    'https://example.com',
    ('--load-extension="{0}"' -f $RepoRoot),
    '--disable-features=UseChromeOSDirectVideoDecoder'
  )
  Start-Process -FilePath $ChromePath -ArgumentList $arguments -WorkingDirectory $RepoRoot -WindowStyle Hidden
}

function Test-RedlineSourcePath {
  param([string]$FullPath, [string]$RepoRoot)
  $root = [IO.Path]::GetFullPath($RepoRoot).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
  $full = [IO.Path]::GetFullPath($FullPath)
  if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $relative = $full.Substring($root.Length)
  if (($relative -split '[\\/]') | Where-Object { $_ -in @('.git', '.chrome-redline-profile', 'node_modules', '.codestring') }) { return $false }
  return [IO.Path]::GetExtension($full) -in @('.js', '.mjs', '.json', '.css', '.html', '.svg')
}
