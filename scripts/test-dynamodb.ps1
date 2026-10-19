$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$name = "techx-dynamodb-test-$PID"
$previousEndpoint = [Environment]::GetEnvironmentVariable('DYNAMODB_TEST_ENDPOINT')
try {
  docker run -d --name $name -p '127.0.0.1::8000' amazon/dynamodb-local:2.6.1 -jar DynamoDBLocal.jar -inMemory -sharedDb | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Unable to start isolated DynamoDB Local.' }
  $port = docker inspect --format '{{(index (index .NetworkSettings.Ports "8000/tcp") 0).HostPort}}' $name
  if ($LASTEXITCODE -ne 0 -or $port -notmatch '^\d+$') { throw 'Unable to resolve isolated DynamoDB port.' }
  $env:DYNAMODB_TEST_ENDPOINT = "http://127.0.0.1:$port"
  Push-Location $root
  try {
    npm run test:dynamodb -w @techx/order-api
    if ($LASTEXITCODE -ne 0) { throw 'DynamoDB Local integration tests failed.' }
  } finally { Pop-Location }
} finally {
  docker rm -f $name 2>$null | Out-Null
  if ($null -eq $previousEndpoint) { Remove-Item Env:DYNAMODB_TEST_ENDPOINT -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('DYNAMODB_TEST_ENDPOINT', $previousEndpoint) }
}
