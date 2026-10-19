$ErrorActionPreference = 'Stop'

$required = @(
  '.env.example',
  '.gitignore',
  'LICENSE',
  'README.md',
  'package-lock.json',
  'package.json',
  'compose.yaml',
  'src/catalog-api/Dockerfile',
  'src/order-api/Dockerfile',
  'src/frontend/Dockerfile',
  'src/frontend/README.md',
  'src/frontend/package.json',
  'src/catalog-api/README.md',
  'src/order-api/README.md',
  'scripts/container-resilience.ps1',
  'scripts/publish-ecr-images.ps1'
)

foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required bootstrap file: $path"
  }
}

$forbidden = git ls-files | Select-String -Pattern '(^|/)(\.env$|node_modules/|\.next/|dist/|coverage/)|\.(tfstate|tfplan|tsbuildinfo)$'
if ($forbidden) {
  throw "Forbidden generated or sensitive path is tracked: $($forbidden -join ', ')"
}

if (-not (Test-Path -LiteralPath 'node_modules')) {
  throw 'Dependencies are missing. Run npm ci before verification.'
}

& "$PSScriptRoot\ui-hardcode-audit.ps1"

foreach ($script in Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1') {
  $tokens = $null
  $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors) { throw "$($script.Name) has syntax errors: $($parseErrors.Message -join '; ')" }
}
& (Join-Path $PSScriptRoot 'test-publish-ecr-images.ps1')
npm audit --audit-level=high
if ($LASTEXITCODE -ne 0) { throw 'Dependency audit found HIGH/CRITICAL vulnerabilities or could not complete.' }

npm run check
if ($LASTEXITCODE -ne 0) { throw 'TypeScript verification failed.' }
npm run format:check
if ($LASTEXITCODE -ne 0) { throw 'Formatting verification failed.' }
npm run lint
if ($LASTEXITCODE -ne 0) { throw 'Lint verification failed.' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Test verification failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Production build verification failed.' }

Write-Host 'techx-platform local verification passed.'
