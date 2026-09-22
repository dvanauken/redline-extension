$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/watch-reload-functions.ps1')
$testRoot = 'C:\Redline Test\extension'
$testProfile = Join-Path $testRoot '.chrome-redline-profile'
$cases = @(
  @{ Id = 1; Line = 'chrome.exe --profile-directory=Default'; Match = $false },
  @{ Id = 2; Line = ('chrome.exe --user-data-dir="{0}"' -f $testProfile); Match = $true },
  @{ Id = 3; Line = ('chrome.exe "--user-data-dir={0}"' -f $testProfile); Match = $true },
  @{ Id = 4; Line = ('chrome.exe --user-data-dir "{0}"' -f $testProfile); Match = $true },
  @{ Id = 5; Line = ('chrome.exe --user-data-dir="{0}-other"' -f $testProfile); Match = $false },
  @{ Id = 6; Line = 'chrome.exe --user-data-dir=C:\unrelated'; Match = $false },
  @{ Id = 7; Line = $null; Match = $false },
  @{ Id = 8; Line = ('chrome.exe --user-data-dir="{0}\"' -f $testProfile.ToUpperInvariant()); Match = $true }
)
$script:fixtureProcesses = @($cases | ForEach-Object { [pscustomobject]@{ Name = 'chrome.exe'; ProcessId = $_.Id; CommandLine = $_.Line } })
$matched = @(Get-RedlineChromeProcess -Processes $script:fixtureProcesses -ProfileDir $testProfile)
foreach ($case in $cases) {
  if (($matched.ProcessId -contains $case.Id) -ne $case.Match) { throw "Process matching failed for case $($case.Id)" }
}
# Exercise the restart function with mocked OS calls: never stop a real browser.
$script:stopped = @()
$script:launch = $null
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) $script:fixtureProcesses }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:stopped += $Id }
function Wait-Process { param($Id, $Timeout, $ErrorAction) }
function Start-Process { param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle) $script:launch = $PSBoundParameters }
Restart-RedlineChrome -ChromePath 'C:\Chrome\chrome.exe' -RepoRoot $testRoot -ProfileDir $testProfile
if (($script:stopped -join ',') -ne '2,3,4,8') { throw 'Restart affected unrelated processes.' }
if ($script:launch.WindowStyle -ne 'Hidden') { throw 'Launch must be hidden.' }
if ($script:launch.ArgumentList -notcontains ('--user-data-dir="{0}"' -f $testProfile)) { throw 'Profile argument lost its quoting.' }
if ($script:launch.ArgumentList -notcontains ('--load-extension="{0}"' -f $testRoot)) { throw 'Extension argument lost its quoting.' }
foreach ($relative in @('main.js', 'redline\RedlineOverlay.js', 'redline\icons\pen.svg')) {
  if (-not (Test-RedlineSourcePath -FullPath (Join-Path $testRoot $relative) -RepoRoot $testRoot)) { throw "Source excluded: $relative" }
}
foreach ($relative in @('.chrome-redline-profile\Preferences.json', '.git\config.json', 'node_modules\a.js', '.codestring\state.json', 'README.md', '..\outside.js')) {
  if (Test-RedlineSourcePath -FullPath (Join-Path $testRoot $relative) -RepoRoot $testRoot) { throw "Non-source included: $relative" }
}
Write-Output 'PASS: process isolation, quoted paths, hidden launch, and watcher exclusions.'
