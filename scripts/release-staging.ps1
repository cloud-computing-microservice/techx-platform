param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9]{12}$')][string]$ExpectedAccountId,
  [string]$Region = 'us-east-1',
  [string]$ChartPath = '',
  [switch]$Push,
  [string]$Context = '',
  [string]$PublicUrl = 'https://shop.dinhminhkhoa.id.vn'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $ChartPath) { $ChartPath = Join-Path (Split-Path -Parent $root) 'techx-chart' }
$ChartPath = (Resolve-Path -LiteralPath $ChartPath).Path
foreach ($repo in @($root, $ChartPath)) {
  $dirty = git -C $repo status --porcelain --untracked-files=all
  if ($LASTEXITCODE -ne 0 -or $dirty) { throw "Release requires a clean, committed worktree: $repo" }
}
if ($Push) {
  if (-not $Context) { throw 'An explicit staging kubectl Context is required with -Push.' }
  $cluster = aws eks describe-cluster --region $Region --name techx-staging --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $cluster.cluster.arn -notlike "arn:aws:eks:${Region}:${ExpectedAccountId}:cluster/techx-staging") { throw 'AWS staging cluster does not match the expected account and region.' }
  $kubeConfig = kubectl config view --minify --context $Context -o json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $kubeConfig.clusters[0].cluster.server -ne $cluster.cluster.endpoint) { throw 'kubectl Context points to a different EKS cluster.' }
  git -C $ChartPath fetch origin main
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the current GitOps main branch.' }
  git -C $ChartPath merge-base --is-ancestor origin/main HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Merge the latest chart origin/main before release; publishing would overwrite newer GitOps changes.' }
  $application = kubectl --context $Context -n argocd get application techx-staging -o json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $application.spec.destination.namespace -ne 'techx-staging' -or $application.spec.source.targetRevision -ne 'main') {
    throw 'The selected Kubernetes context does not expose the expected staging GitOps application.'
  }
  $origin = (git -C $ChartPath remote get-url origin).Trim() -replace '\.git$', '' -replace '^git@github.com:', 'https://github.com/'
  if ($LASTEXITCODE -ne 0 -or $origin -ne ($application.spec.source.repoURL -replace '\.git$', '')) { throw 'Chart origin does not match the active Argo CD source repository.' }
  kubectl --context $Context apply -f (Join-Path $ChartPath 'gitops/clusters/staging/application.yaml') | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Unable to reconcile the staging Application contract.' }
  kubectl --context $Context label namespace techx-staging elbv2.k8s.aws/pod-readiness-gate-inject=enabled --overwrite | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Unable to enable ALB target readiness before rollout.' }
}

Push-Location $root
try { & (Join-Path $PSScriptRoot 'verify.ps1') } finally { Pop-Location }
$manifest = & (Join-Path $PSScriptRoot 'publish-ecr-images.ps1') -ExpectedAccountId $ExpectedAccountId -Region $Region | ConvertFrom-Json
if (-not $manifest.tag -or $manifest.images.Count -ne 3) { throw 'The publisher returned an incomplete manifest.' }

$valuesPath = Join-Path $ChartPath 'values-staging.yaml'
$originalValues = Get-Content -Raw -LiteralPath $valuesPath
$updatedValues = $originalValues
foreach ($entry in $manifest.images) {
  $repository = $entry.image -replace ':[^:]+$', ''
  $pattern = '(?m)(repository: ' + [regex]::Escape($repository) + '\r?\n\s+tag: )[^\r\n]+'
  if ([regex]::Matches($updatedValues, $pattern).Count -ne 1) { throw "Chart repository is missing or ambiguous: $repository" }
  $updatedValues = [regex]::Replace($updatedValues, $pattern, '${1}' + $manifest.tag)
}
$manifestPath = Join-Path $ChartPath 'releases/staging.json'
$previousManifest = if (Test-Path -LiteralPath $manifestPath) { Get-Content -Raw -LiteralPath $manifestPath } else { $null }
try {
  [IO.File]::WriteAllText($valuesPath, $updatedValues)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $manifestPath) | Out-Null
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Push-Location $ChartPath
  try { & (Join-Path $ChartPath 'scripts/verify.ps1') } finally { Pop-Location }
} catch {
  [IO.File]::WriteAllText($valuesPath, $originalValues)
  if ($null -ne $previousManifest) { [IO.File]::WriteAllText($manifestPath, $previousManifest) }
  else { Remove-Item -LiteralPath $manifestPath -ErrorAction SilentlyContinue }
  throw
}

git -C $ChartPath add -- values-staging.yaml releases/staging.json
if ($LASTEXITCODE -ne 0) { throw 'Unable to stage release metadata.' }
git -C $ChartPath diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
  git -C $ChartPath commit -m "chore(staging): release $($manifest.tag)"
  if ($LASTEXITCODE -ne 0) { throw 'Chart release commit failed.' }
} elseif ($LASTEXITCODE -ne 0) { throw 'Unable to inspect staged release diff.' }
$revision = (git -C $ChartPath rev-parse HEAD).Trim()
if (-not $Push) {
  Write-Host "Prepared and committed $($manifest.tag) locally. Inspect the chart commit; rerun with -Push for GitOps deploy and acceptance."
  return
}
git -C $ChartPath push origin HEAD:main
if ($LASTEXITCODE -ne 0) { throw 'GitOps push failed; rerun after resolving the upstream change.' }
kubectl --context $Context -n argocd annotate application techx-staging argocd.argoproj.io/refresh=hard --overwrite | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'Unable to request immediate GitOps reconciliation.' }
& (Join-Path $ChartPath 'scripts/aws-acceptance.ps1') -Action WaitRevision -Context $Context -ExpectedRevision $revision -ExpectedImageTag $manifest.tag
& (Join-Path $ChartPath 'scripts/aws-acceptance.ps1') -Action Baseline -Context $Context -ExposureProfile domainVpn -NetworkView Public -PublicUrl $PublicUrl
Write-Host "Released $($manifest.tag); GitOps Synced/Healthy and public acceptance passed."
