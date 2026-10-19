$ErrorActionPreference = 'Stop'
$publisherTestState = @{ built = @(); present = @{}; account = '058114477594'; buildFails = $false; inspectionFails = $false }
$originalRevision = [Environment]::GetEnvironmentVariable('REVISION')
$originalRegistry = [Environment]::GetEnvironmentVariable('REGISTRY')
$manifestPath = Join-Path ([IO.Path]::GetTempPath()) "techx-release-test-$PID.json"

# These functions intercept all external calls made by the publisher. No AWS,
# Docker, Git mutation or credentials are used by this regression suite.
function git {
  $global:LASTEXITCODE = 0
  if ($args -contains 'status') { return }
  return ('a' * 40)
}
function aws {
  $global:LASTEXITCODE = 0
  switch ($args[1]) {
    'get-caller-identity' { return @{ Account = $publisherTestState.account } | ConvertTo-Json }
    'describe-repositories' { return @{ repositories = @(@{ imageTagMutability = 'IMMUTABLE' }) } | ConvertTo-Json -Depth 4 }
    'describe-images' {
      if ($publisherTestState.inspectionFails) { $global:LASTEXITCODE = 1; return '(AccessDeniedException)' }
      $name = ($args[[array]::IndexOf($args, '--repository-name') + 1] -split '/')[1]
      if (-not $publisherTestState.present[$name]) { $global:LASTEXITCODE = 1; return '(ImageNotFoundException)' }
      return @{ imageDetails = @(@{ imageDigest = "sha256:$('b' * 64)" }) } | ConvertTo-Json -Depth 4
    }
    'get-login-password' { return 'test-password-never-printed' }
    'describe-image-scan-findings' { return @{ imageScanStatus = @{ status = 'COMPLETE' }; imageScanFindings = @{ findingSeverityCounts = @{ HIGH = 0; CRITICAL = 0 } } } | ConvertTo-Json -Depth 5 }
    default { throw "Unexpected AWS command: $args" }
  }
}
function docker {
  $global:LASTEXITCODE = 0
  if ($args[1] -eq 'bake') {
    $publisherTestState.built = @($args | Where-Object { $_ -in @('frontend', 'catalog', 'order') })
    if ($publisherTestState.buildFails) { $global:LASTEXITCODE = 1; return }
    foreach ($name in $publisherTestState.built) { $publisherTestState.present[$name] = $true }
  }
}
function Assert([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

try {
  $env:REVISION = 'caller-value-to-preserve'
  $publisherTestState.present = @{ frontend = $true }
  & "$PSScriptRoot/publish-ecr-images.ps1" -ExpectedAccountId '058114477594' -ManifestPath $manifestPath | Out-Null
  Assert (($publisherTestState.built -join ',') -eq 'catalog,order') 'Partial releases must build only missing images.'
  Assert ($env:REVISION -eq 'caller-value-to-preserve') 'Publisher must restore caller environment.'
  Assert ([Environment]::GetEnvironmentVariable('REGISTRY') -eq $originalRegistry) 'Publisher must preserve an absent REGISTRY variable.'
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  Assert ($manifest.images.Count -eq 3 -and $manifest.commit.Length -eq 40) 'Manifest must contain full commit and all three digests.'
  $publisherTestState.built = @()
  & "$PSScriptRoot/publish-ecr-images.ps1" -ExpectedAccountId '058114477594' | Out-Null
  Assert ($publisherTestState.built.Count -eq 0) 'Completed releases must be repeatable without a build.'

  $publisherTestState.inspectionFails = $true
  $rejected = $false
  try { & "$PSScriptRoot/publish-ecr-images.ps1" -ExpectedAccountId '058114477594' | Out-Null } catch { $rejected = $_ -match 'Unable to inspect ECR' }
  Assert $rejected 'ECR access errors must fail instead of being mistaken for missing images.'
  $publisherTestState.inspectionFails = $false
  $publisherTestState.present = @{}
  $publisherTestState.buildFails = $true
  $rejected = $false
  try { & "$PSScriptRoot/publish-ecr-images.ps1" -ExpectedAccountId '058114477594' | Out-Null } catch { $rejected = $_ -match 'Image build/push failed' }
  Assert $rejected 'Build failure must stop release.'
  Assert ($env:REVISION -eq 'caller-value-to-preserve') 'Failure must restore caller environment.'
  $publisherTestState.buildFails = $false
  $publisherTestState.account = '000000000000'
  $rejected = $false
  try { & "$PSScriptRoot/publish-ecr-images.ps1" -ExpectedAccountId '058114477594' | Out-Null } catch { $rejected = $_ -match 'identity' }
  Assert $rejected 'Wrong AWS account must be rejected.'
  Write-Host 'Publisher regression tests passed: resume, no-op, manifest, access denial, build failure, account and environment.'
} finally {
  Remove-Item -LiteralPath $manifestPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $originalRevision) { Remove-Item Env:REVISION -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('REVISION', $originalRevision) }
}
