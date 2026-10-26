param(
  [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha,
  [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9-]{8,80}$')][string]$SessionId,
  [Parameter(Mandatory)][string]$SessionBucket,
  [Parameter(Mandatory)][string]$LeaseOwner,
  [Parameter(Mandatory)][string]$AutomationScripts
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $env:GH_TOKEN -or -not $env:GITHUB_TOKEN) { throw 'Scoped chart writer and platform read tokens are required.' }
if (-not $env:RUNNER_TEMP) { throw 'This entry point requires an ephemeral automation runner.' }
# The immutable infra execution pins this helper. It verifies the real source
# workflow/CI, owns the heartbeat lease, and persists the candidate before ECR.
python (Join-Path $AutomationScripts 'run_ready_release.py') --bucket $SessionBucket --session-id $SessionId `
  --source-sha $SourceSha --owner $LeaseOwner --platform $root
if ($LASTEXITCODE -ne 0) { throw 'Active release publication/proposal failed. Inspect the candidate receipts.' }
