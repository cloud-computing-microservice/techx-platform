param([ValidateRange(1024, 65535)][int]$Port = 3180)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$previous = @{}
foreach ($key in @('ORDER_API_KEY', 'FRONTEND_PORT', 'COMPOSE_PROJECT_NAME', 'IMAGE_TAG', 'REGISTRY', 'REVISION')) {
  $previous[$key] = [Environment]::GetEnvironmentVariable($key)
}
Push-Location $root
try {
  & (Join-Path $PSScriptRoot 'verify.ps1')
  & (Join-Path $PSScriptRoot 'test-dynamodb.ps1')
  $env:REGISTRY = 'techx'
  $env:IMAGE_TAG = 'local'
  $env:REVISION = 'local'
  docker buildx bake -f docker-bake.hcl --load
  if ($LASTEXITCODE -ne 0) { throw 'Local image build failed.' }
  $env:ORDER_API_KEY = "local-$([guid]::NewGuid())"
  $env:FRONTEND_PORT = [string]$Port
  $env:COMPOSE_PROJECT_NAME = "techx-acceptance-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  $env:IMAGE_TAG = 'local'
  docker compose up -d --no-build --wait --wait-timeout 150
  if ($LASTEXITCODE -ne 0) { throw 'Local stack did not become healthy.' }
  $baseUrl = "http://127.0.0.1:$Port"
  & (Join-Path $PSScriptRoot 'container-smoke.ps1') -BaseUrl $baseUrl
  & (Join-Path $PSScriptRoot 'container-resilience.ps1') -BaseUrl $baseUrl
  & (Join-Path $PSScriptRoot 'container-recovery.ps1') -BaseUrl $baseUrl
  & (Join-Path $PSScriptRoot 'container-soak.ps1') -BaseUrl $baseUrl
  & (Join-Path $PSScriptRoot 'container-audit.ps1')
  Write-Host 'Full isolated local acceptance passed.'
} finally {
  # Only remove resources belonging to the unique project created above.
  if ($env:COMPOSE_PROJECT_NAME -like 'techx-acceptance-*' -and $env:COMPOSE_PROJECT_NAME -ne $previous['COMPOSE_PROJECT_NAME']) {
    docker compose down --volumes --remove-orphans | Out-Host
  }
  Pop-Location
  foreach ($key in $previous.Keys) {
    if ($null -eq $previous[$key]) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($key, $previous[$key]) }
  }
}
