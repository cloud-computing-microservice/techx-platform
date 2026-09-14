param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9]{12}$')][string]$ExpectedAccountId,
  [string]$Region = 'us-east-1'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dirty = git -C $root status --porcelain --untracked-files=all
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Git worktree.' }
if ($dirty) { throw 'Commit the reviewed application changes before publishing immutable images.' }

$identity = aws sts get-caller-identity --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $identity.Account -ne $ExpectedAccountId) {
  throw 'Current AWS identity does not match ExpectedAccountId.'
}
$shortSha = (git -C $root rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $shortSha -notmatch '^[0-9a-f]{12}$') { throw 'Unable to resolve the application commit.' }
$tag = "staging-$shortSha"
$registry = "$ExpectedAccountId.dkr.ecr.$Region.amazonaws.com"
$images = [ordered]@{
  frontend = 'src/frontend/Dockerfile'
  catalog = 'src/catalog-api/Dockerfile'
  order = 'src/order-api/Dockerfile'
}

foreach ($name in $images.Keys) {
  $repositoryName = "techx/$name"
  $repository = aws ecr describe-repositories --region $Region --repository-names $repositoryName --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $repository.repositories.Count -ne 1 -or $repository.repositories[0].imageTagMutability -ne 'IMMUTABLE') {
    throw "ECR repository $repositoryName is missing or not immutable."
  }
  aws ecr describe-images --region $Region --repository-name $repositoryName --image-ids "imageTag=$tag" --output json 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) { throw "Immutable image already exists: ${repositoryName}:$tag" }
}

aws ecr get-login-password --region $Region | docker login --username AWS --password-stdin $registry | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker login to ECR failed.' }
docker buildx inspect | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Buildx is unavailable.' }

$published = @()
foreach ($name in $images.Keys) {
  $repositoryName = "techx/$name"
  $image = "${registry}/${repositoryName}:$tag"
  # ECR basic scanning requires an image manifest rather than an OCI index with attestations.
  docker buildx build --platform linux/amd64 --provenance=false --file (Join-Path $root $images[$name]) --tag $image --push $root
  if ($LASTEXITCODE -ne 0) { throw "Build/push failed for $name." }
  $details = aws ecr describe-images --region $Region --repository-name $repositoryName --image-ids "imageTag=$tag" --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $details.imageDetails.Count -ne 1 -or -not $details.imageDetails[0].imageDigest) {
    throw "ECR did not return a digest for $image."
  }
  $published += [ordered]@{ component = $name; image = $image; digest = $details.imageDetails[0].imageDigest }
}

[ordered]@{
  commit = $shortSha
  tag = $tag
  images = $published
} | ConvertTo-Json -Depth 5
