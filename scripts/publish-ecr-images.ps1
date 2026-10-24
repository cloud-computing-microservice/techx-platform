param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9]{12}$')][string]$ExpectedAccountId,
  [string]$Region = 'us-east-1',
  [string]$ManifestPath = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dirty = git -C $root status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Git worktree.' }
if ($dirty) { throw 'Commit the reviewed application changes before publishing immutable images.' }

$commit = (git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Unable to resolve the application commit.' }
. (Join-Path $PSScriptRoot 'ecr-publisher-core.ps1')
Invoke-TechxEcrPublish -SourceRoot $root -SourceSha $commit -ExpectedAccountId $ExpectedAccountId -Region $Region -ManifestPath $ManifestPath
