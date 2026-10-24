# Shared publisher mechanics. Callers must independently authenticate source:
# the manual entry point requires clean Git; cold publish uses a verified archive.
function Invoke-TechxEcrPublish {
  param(
    [Parameter(Mandatory)][string]$SourceRoot,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$SourceSha,
    [Parameter(Mandatory)][ValidateSet('058114477594')][string]$ExpectedAccountId,
    [ValidateSet('us-east-1')][string]$Region = 'us-east-1',
    [string]$ManifestPath = ''
  )
  $ErrorActionPreference = 'Stop'
  $root = [IO.Path]::GetFullPath($SourceRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $root 'docker-bake.hcl') -PathType Leaf)) {
    throw 'The authenticated source must contain the reviewed Docker Bake definition.'
  }
  $commit = $SourceSha
  $identity = aws sts get-caller-identity --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $identity.Account -ne $ExpectedAccountId) {
    throw 'Current AWS identity does not match ExpectedAccountId.'
  }
  $tag = "staging-$($commit.Substring(0, 12))"
  $registry = "$ExpectedAccountId.dkr.ecr.$Region.amazonaws.com/techx"
  $names = @('frontend', 'catalog', 'order')

  function Get-RemoteImage([string]$Name) {
    $raw = aws ecr describe-images --region $Region --repository-name "techx/$Name" --image-ids "imageTag=$tag" --output json 2>&1
    if ($LASTEXITCODE -ne 0) {
      if (($raw -join "`n") -match '\(ImageNotFoundException\)') { return $null }
      throw "Unable to inspect ECR image ${Name}:$tag. $($raw -join ' ')"
    }
    $details = ($raw -join "`n" | ConvertFrom-Json).imageDetails
    if ($details.Count -ne 1 -or $details[0].imageDigest -notmatch '^sha256:[0-9a-f]{64}$') {
      throw "ECR did not return a valid digest for ${Name}:$tag."
    }
    return $details[0]
  }

  $pending = @()
  foreach ($name in $names) {
    $repository = aws ecr describe-repositories --region $Region --repository-names "techx/$name" --output json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $repository.repositories.Count -ne 1 -or $repository.repositories[0].imageTagMutability -ne 'IMMUTABLE') {
      throw "ECR repository techx/$name is missing or not immutable."
    }
    if (-not (Get-RemoteImage $name)) { $pending += $name }
  }

  if ($pending.Count -gt 0) {
    $loginPassword = aws ecr get-login-password --region $Region
    if ($LASTEXITCODE -ne 0 -or -not $loginPassword) { throw 'Unable to obtain ECR login credentials.' }
    try {
      $loginPassword | docker login --username AWS --password-stdin "$ExpectedAccountId.dkr.ecr.$Region.amazonaws.com" | Out-Host
      if ($LASTEXITCODE -ne 0) { throw 'Docker login to ECR failed.' }
    } finally { $loginPassword = $null }

    docker buildx inspect | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Docker Buildx is unavailable.' }
    $previous = @{}
    foreach ($key in @('REGISTRY', 'IMAGE_TAG', 'REVISION')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key) }
    Push-Location $root
    try {
      $env:REGISTRY = $registry
      $env:IMAGE_TAG = $tag
      $env:REVISION = $commit
      # Bake builds missing targets concurrently and shares identical dependency
      # layers. Rerunning a partial release preserves existing immutable images.
      docker buildx bake -f docker-bake.hcl --push @pending | Out-Host
      if ($LASTEXITCODE -ne 0) { throw 'Image build/push failed; rerun to resume missing images.' }
    } finally {
      Pop-Location
      foreach ($key in $previous.Keys) {
        if ($null -eq $previous[$key]) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $previous[$key]) }
      }
    }
  }

  $published = foreach ($name in $names) {
    $details = Get-RemoteImage $name
    if (-not $details) { throw "Published image is missing: ${name}:$tag." }
    $deadline = [datetimeoffset]::Now.AddMinutes(5)
    do {
      $scanRaw = aws ecr describe-image-scan-findings --region $Region --repository-name "techx/$name" --image-id "imageTag=$tag" --output json 2>&1
      if ($LASTEXITCODE -ne 0) {
        if (($scanRaw -join "`n") -notmatch '\(ScanNotFoundException\)') { throw "Unable to inspect vulnerability scan for ${name}:$tag." }
        $scan = $null
      } else { $scan = $scanRaw -join "`n" | ConvertFrom-Json }
      if ($scan.imageScanStatus.status -eq 'COMPLETE') { break }
      if ($scan.imageScanStatus.status -in @('FAILED', 'UNSUPPORTED_IMAGE', 'FINDINGS_UNAVAILABLE', 'LIMIT_EXCEEDED')) { throw "Vulnerability scan failed for ${name}:$tag." }
      if ([datetimeoffset]::Now -ge $deadline) { throw "Timed out waiting for ECR vulnerability scan: ${name}:$tag." }
      Start-Sleep -Seconds 3
    } while ($true)
    if ([int]($scan.imageScanFindings.findingSeverityCounts.CRITICAL ?? 0) -gt 0 -or [int]($scan.imageScanFindings.findingSeverityCounts.HIGH ?? 0) -gt 0) {
      throw "ECR scan found HIGH/CRITICAL vulnerabilities in ${name}:$tag; release stopped."
    }
    [ordered]@{ component = $name; image = "${registry}/${name}:$tag"; digest = $details.imageDigest }
  }
  $manifest = [ordered]@{ commit = $commit; tag = $tag; images = @($published) } | ConvertTo-Json -Depth 5
  if ($ManifestPath) { $manifest | Set-Content -LiteralPath $ManifestPath -Encoding utf8 }
  Write-Output $manifest
}
