$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $repoRoot 'scripts/watch-reload-functions.ps1')
$chromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path -LiteralPath $chromePath)) {
  $chromePath = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path -LiteralPath $chromePath)) {
  throw 'Chrome was not found. Install Chrome first or update the path in this script.'
}
$profileDir = Join-Path $repoRoot '.chrome-redline-profile'
New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = $repoRoot
$watcher.IncludeSubdirectories = $true
$watcher.NotifyFilter = [IO.NotifyFilters]'FileName, DirectoryName, LastWrite'
$eventPrefix = 'RedlineWatch.' + [Guid]::NewGuid().ToString('N') + '.'
$subscriptions = @()
try {
  foreach ($eventName in @('Changed', 'Created', 'Renamed', 'Deleted')) {
    $subscriptions += Register-ObjectEvent -InputObject $watcher -EventName $eventName -SourceIdentifier ($eventPrefix + $eventName)
  }
  $watcher.EnableRaisingEvents = $true
  Write-Host "Watching $repoRoot for changes. Press Ctrl+C to stop."
  Restart-RedlineChrome -ChromePath $chromePath -RepoRoot $repoRoot -ProfileDir $profileDir
  $lastChange = $null
  while ($true) {
    # Handle events in this scope and restart once after a burst of file writes.
    foreach ($pending in @(Get-Event | Where-Object { $_.SourceIdentifier.StartsWith($eventPrefix) })) {
      $paths = @($pending.SourceEventArgs.FullPath)
      if ($pending.SourceEventArgs -is [IO.RenamedEventArgs]) { $paths += $pending.SourceEventArgs.OldFullPath }
      foreach ($changedPath in $paths) {
        if (Test-RedlineSourcePath -FullPath $changedPath -RepoRoot $repoRoot) { $lastChange = [DateTime]::UtcNow }
      }
      Remove-Event -EventIdentifier $pending.EventIdentifier
    }
    if ($lastChange -and ([DateTime]::UtcNow - $lastChange).TotalMilliseconds -ge 350) {
      Restart-RedlineChrome -ChromePath $chromePath -RepoRoot $repoRoot -ProfileDir $profileDir
      Write-Host 'Development Chrome reloaded.'
      $lastChange = $null
    }
    Start-Sleep -Milliseconds 100
  }
} finally {
  $watcher.EnableRaisingEvents = $false
  foreach ($subscription in $subscriptions) { Unregister-Event -SubscriptionId $subscription.SubscriptionId }
  Get-Event | Where-Object { $_.SourceIdentifier.StartsWith($eventPrefix) } | Remove-Event
  $watcher.Dispose()
}
