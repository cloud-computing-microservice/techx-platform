param(
  [string]$BaseUrl = 'http://localhost:3000',
  [int]$RecoveryTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$requestId = "resilience-$([guid]::NewGuid())"
$idempotencyKey = "double-submit-$([guid]::NewGuid())"

function Wait-Healthy([string]$Service) {
  $deadline = (Get-Date).AddSeconds($RecoveryTimeoutSeconds)
  do {
    $id = docker compose ps -q $Service
    if ($LASTEXITCODE -eq 0 -and $id) {
      $status = docker inspect --format '{{.State.Health.Status}}' $id 2>$null
      if ($LASTEXITCODE -eq 0 -and $status.Trim() -eq 'healthy') { return }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  throw "$Service did not become healthy within $RecoveryTimeoutSeconds seconds."
}

foreach ($service in @('catalog-api', 'order-api', 'frontend')) {
  Wait-Healthy $service
}

$catalog = Invoke-RestMethod -Uri "$BaseUrl/api/products" -Headers @{ 'x-request-id' = $requestId } -TimeoutSec 8
$product = $catalog.products | Where-Object { $_.availability -ne 'out_of_stock' } | Select-Object -First 1
if (-not $product.id) { throw 'No orderable product was returned.' }

$body = @{
  items = @(@{ productId = $product.id; quantity = 1 })
  customer = @{ name = 'Resilience Test'; email = 'resilience@example.com' }
  shippingAddress = @{
    line1 = '100 Resilience Street'
    city = 'Seattle'
    region = 'WA'
    postalCode = '98101'
    countryCode = 'US'
  }
  shippingMethod = 'standard'
} | ConvertTo-Json -Depth 6 -Compress

# Model a real double-click: two concurrent requests carry the same idempotency key.
$responses = 1..2 | ForEach-Object -Parallel {
  Invoke-WebRequest -Method Post -Uri "$using:BaseUrl/api/orders" `
    -Headers @{ 'Idempotency-Key' = $using:idempotencyKey; 'x-request-id' = "$using:requestId-$_" } `
    -ContentType 'application/json' -Body $using:body -TimeoutSec 10 -SkipHttpErrorCheck
} -ThrottleLimit 2

$statuses = @($responses.StatusCode | Sort-Object)
if (($statuses -join ',') -ne '200,201') {
  throw "Double-submit expected one 201 and one 200 replay; received $($statuses -join ', ')."
}
$orders = @($responses | ForEach-Object { ($_.Content | ConvertFrom-Json).order })
if ($orders.Count -ne 2 -or $orders[0].id -ne $orders[1].id) {
  throw 'Double-submit created different order IDs.'
}
$orderId = $orders[0].id

$orderLogs = docker compose logs --no-color order-api
if ($LASTEXITCODE -ne 0 -or ($orderLogs -join "`n") -notmatch [regex]::Escape($requestId)) {
  throw 'Order logs did not contain the propagated request ID.'
}
$orderContainer = docker compose ps -q order-api
$secretEntry = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $orderContainer |
  Where-Object { $_ -like 'ORDER_API_KEY=*' } | Select-Object -First 1
$secret = if ($secretEntry) { $secretEntry.Substring('ORDER_API_KEY='.Length) } else { '' }
if (-not $secret -or $secret.Length -lt 8) { throw 'Could not inspect the configured Order API key.' }
$allLogs = docker compose logs --no-color
if (($allLogs -join "`n") -match [regex]::Escape($secret)) { throw 'A runtime log exposed ORDER_API_KEY.' }
Write-Host 'Double-submit, idempotent replay, request-ID correlation, and log redaction passed.'

# Stop only Catalog and prove the public BFF fails closed with a bounded 503.
docker compose stop --timeout 10 catalog-api
if ($LASTEXITCODE -ne 0) { throw 'Could not stop Catalog for the dependency failure test.' }
try {
  $started = Get-Date
  $failure = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/orders" `
    -Headers @{ 'Idempotency-Key' = "catalog-down-$([guid]::NewGuid())"; 'x-request-id' = "$requestId-catalog-down" } `
    -ContentType 'application/json' -Body $body -TimeoutSec 10 -SkipHttpErrorCheck
  $elapsed = ((Get-Date) - $started).TotalSeconds
  $failureBody = $failure.Content | ConvertFrom-Json
  $acceptedCodes = @('CATALOG_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE')
  if ($failure.StatusCode -ne 503 -or $failureBody.error.code -notin $acceptedCodes) {
    throw "Catalog failure expected a dependency 503; received $($failure.StatusCode)/$($failureBody.error.code)."
  }
  if ($elapsed -gt 8) { throw "Catalog failure exceeded the bounded timeout: $([math]::Round($elapsed, 2)) seconds." }
}
finally {
  docker compose start catalog-api
  if ($LASTEXITCODE -ne 0) { throw 'Could not restart Catalog after the failure test.' }
  Wait-Healthy 'catalog-api'
}
& "$PSScriptRoot/container-smoke.ps1" -BaseUrl $BaseUrl
Write-Host 'Catalog dependency failure returned bounded 503 and recovered.'

# DynamoDB owns order state: an Order restart must recover health and preserve lookup.
docker compose restart --timeout 10 order-api
if ($LASTEXITCODE -ne 0) { throw 'Could not restart Order for the persistence recovery test.' }
Wait-Healthy 'order-api'
$lookup = Invoke-WebRequest -Uri "$BaseUrl/api/orders/$orderId" -TimeoutSec 8 -SkipHttpErrorCheck
if ($lookup.StatusCode -ne 200) {
  throw "Order restart expected persisted lookup/200; received $($lookup.StatusCode)."
}
& "$PSScriptRoot/container-smoke.ps1" -BaseUrl $BaseUrl
Write-Host 'Order restart recovered service health and preserved DynamoDB-backed order data.'
Write-Host "Container resilience acceptance passed (request ID prefix: $requestId)."
