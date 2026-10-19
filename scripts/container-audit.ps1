$ErrorActionPreference = 'Stop'
$services = @('catalog-api', 'order-api', 'frontend')

npm audit --omit=dev --audit-level=high
if ($LASTEXITCODE -ne 0) { throw 'Production dependency audit failed.' }

foreach ($service in $services) {
  $id = docker compose ps -q $service
  if ($LASTEXITCODE -ne 0 -or -not $id) { throw "No container for $service." }

  $user = docker inspect --format '{{.Config.User}}' $id
  $readOnly = docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' $id
  $capDrop = docker inspect --format '{{json .HostConfig.CapDrop}}' $id
  $securityOpt = docker inspect --format '{{json .HostConfig.SecurityOpt}}' $id
  $image = docker inspect --format '{{.Config.Image}}' $id
  $architecture = docker image inspect --format '{{.Architecture}}' $image

  if (-not $user -or $user -match '^(0|root)(:|$)') { throw "$service runs as root." }
  if ($readOnly.Trim() -ne 'true') { throw "$service root filesystem is writable." }
  if ($capDrop -notmatch 'ALL') { throw "$service does not drop all capabilities." }
  if ($securityOpt -notmatch 'no-new-privileges') { throw "$service lacks no-new-privileges." }
  if ($architecture.Trim() -ne 'amd64') { throw "$service image is not linux/amd64." }

  $history = docker history --no-trunc $image
  if ($history -match 'local-demo-key|replace-with-a-random') {
    throw "$service image history contains a demo secret value."
  }
  $sensitiveFiles = docker run --rm --entrypoint sh $image -c "find /app -type f \( -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name '*.tfstate' \) -print"
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect $service image filesystem." }
  if ($sensitiveFiles) { throw "$service image contains sensitive-looking files: $($sensitiveFiles -join ', ')." }
  $runtimeUid = docker exec $id id -u
  if ($LASTEXITCODE -ne 0 -or $runtimeUid.Trim() -eq '0') { throw "$service runtime UID is not a numeric non-root user." }
  $size = [int64](docker image inspect --format '{{.Size}}' $image)
  if ($size -gt 524288000) { throw "$service image exceeds the 500 MiB local ceiling." }
  Write-Host "$service hardened; image size $([math]::Round($size / 1MB, 1)) MiB."
}

Write-Host 'Container hardening, history, architecture, size, and dependency audit passed.'
