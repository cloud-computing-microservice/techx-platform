param(
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9-]{8,80}$')][string]$SessionId,
  [Parameter(Mandatory)][string]$SessionBucket,
  [Parameter(Mandatory)][string]$LeaseOwner,
  [Parameter(Mandatory)][string]$AutomationScripts
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $env:GH_TOKEN) { throw 'A scoped GitHub App token is required.' }
if (-not $env:RUNNER_TEMP) { throw 'This entry point requires an ephemeral automation runner.' }
$actual = (git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actual -ne $SourceSha) { throw 'Checked-out source does not match the verified source SHA.' }
$manifestPath = Join-Path $env:RUNNER_TEMP 'release.json'
& (Join-Path $PSScriptRoot 'publish-ecr-images.ps1') -ExpectedAccountId '058114477594' -ManifestPath $manifestPath | Out-Null
$chart = Join-Path $env:RUNNER_TEMP "chart-$SourceSha-$([guid]::NewGuid())"
function Invoke-ChartGit([string[]]$Arguments) {
  & git -c 'credential.helper=!gh auth git-credential' -C $chart @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Chart Git command failed: $($Arguments[0])" }
}
git -c 'credential.helper=!gh auth git-credential' clone --branch main --single-branch `
  'https://github.com/cloud-computing-microservice/techx-chart.git' $chart | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Unable to clone the trusted chart main branch.' }
python (Join-Path $PSScriptRoot 'prepare-chart-release.py') --chart $chart --manifest $manifestPath
if ($LASTEXITCODE -ne 0) { throw 'Release manifest validation/preparation failed.' }
Push-Location $chart
try { & (Join-Path $chart 'scripts/verify.ps1') } finally { Pop-Location }

# Recheck the current CAS lease immediately before creating a GitOps proposal.
python (Join-Path $AutomationScripts 'assert-release-lease.py') `
  --bucket $SessionBucket --session-id $SessionId --owner $LeaseOwner
if ($LASTEXITCODE -ne 0) { throw 'Release window or lease changed before promote.' }
$branch = "release/staging-$($SourceSha.Substring(0, 12))"
Invoke-ChartGit @('config', 'user.name', 'techx-release[bot]')
Invoke-ChartGit @('config', 'user.email', 'techx-release[bot]@users.noreply.github.com')
Invoke-ChartGit @('checkout', '-b', $branch)
Invoke-ChartGit @('add', '--', 'values-staging.yaml', 'releases/staging.json')
git -C $chart diff --cached --quiet
if ($LASTEXITCODE -eq 0) { Write-Host 'The chart main branch already selects this release.'; return }
if ($LASTEXITCODE -ne 1) { throw 'Unable to inspect release diff.' }
Invoke-ChartGit @('commit', '-m', "chore(staging): release $($SourceSha.Substring(0, 12))")
$remote = git -c 'credential.helper=!gh auth git-credential' -C $chart ls-remote --exit-code --heads origin $branch
if ($LASTEXITCODE -eq 0) {
  Invoke-ChartGit @('fetch', 'origin', $branch)
  # A retry can reuse an identical proposal, never overwrite an older branch.
  Invoke-ChartGit @('diff', '--exit-code', 'FETCH_HEAD', 'HEAD', '--', 'values-staging.yaml', 'releases/staging.json')
} elseif ($LASTEXITCODE -eq 2) {
  Invoke-ChartGit @('push', 'origin', "HEAD:refs/heads/$branch")
} else { throw 'Unable to inspect the remote release branch.' }
$repo = 'cloud-computing-microservice/techx-chart'
$existing = gh pr list --repo $repo --head $branch --base main --state open --json number | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing release PRs.' }
if (@($existing).Count -eq 0) {
  $bodyFile = Join-Path $env:RUNNER_TEMP 'release-body.md'
  @"
Source commit: $SourceSha

Staging session: $SessionId

Three immutable ECR digests passed the HIGH/CRITICAL scan gate. Chart CI and review are required before merge. This proposal must not be merged after the staging session closes.
"@ | Set-Content -LiteralPath $bodyFile -Encoding utf8
  gh pr create --repo $repo --base main --head $branch `
    --title "chore(staging): release $($SourceSha.Substring(0, 12))" --body-file $bodyFile | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the chart release PR.' }
}
