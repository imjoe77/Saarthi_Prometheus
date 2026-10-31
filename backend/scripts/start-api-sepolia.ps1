<#
.SYNOPSIS
  Start the backend API in OPT-IN Sepolia mode.

.DESCRIPTION
  Reads backend/.env.sepolia (RPC, confirmations, key file paths - no secrets)
  and blockchain/deployments/sepolia.json (chain id, addresses, deploy block),
  refuses to start unless every guard passes, then runs `npm run dev:api` with
  BLOCKCHAIN_* injected into the PROCESS environment only.

  backend/.env is never modified. Plain `npm run dev:api` afterwards still
  starts the original local/disabled configuration.
  Guards refuse anything that is not chain id 11155111 (no silent switching,
  no mainnet, ever).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File backend\scripts\start-api-sepolia.ps1
  powershell -ExecutionPolicy Bypass -File backend\scripts\start-api-sepolia.ps1 -SkipRun   # pre-flight checks only
#>
[CmdletBinding()]
param(
  [string]$ConfigPath,
  [string]$DeploymentRecord,
  # Single-shot (`start` = build + run). Never `dev`/watch: a second watcher
  # shares backend/dist with the local stack and the two rebuilds race.
  [string]$Command = 'start',
  [switch]$SkipRun
)

$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$repoRoot = Split-Path -Parent $backendRoot
$blockchainRoot = Join-Path $repoRoot 'blockchain'
$EXPECTED_CHAIN_ID = 11155111

function Fail([string]$message) {
  Write-Host "REFUSING: $message" -ForegroundColor Red
  exit 1
}

function Invoke-Eth([string]$Url, [string]$Method, [array]$Params) {
  $payload = @{ jsonrpc = '2.0'; id = 1; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 6
  try {
    $resp = Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 15
  } catch {
    throw "RPC call $Method to $Url failed: $($_.Exception.Message)"
  }
  if ($resp.error) { throw "RPC $Method returned error: $(ConvertTo-Json -InputObject $resp.error -Compress)" }
  return $resp.result
}

if (-not $ConfigPath) { $ConfigPath = Join-Path $backendRoot '.env.sepolia' }
if (-not $DeploymentRecord) { $DeploymentRecord = Join-Path $blockchainRoot 'deployments\sepolia.json' }

# --- profile (KEY=VALUE, comments allowed) ----------------------------------
if (-not (Test-Path $ConfigPath)) { Fail "missing profile $ConfigPath" }
$conf = @{}
foreach ($line in Get-Content $ConfigPath) {
  $trimmed = $line.Trim()
  if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
  $idx = $trimmed.IndexOf('=')
  if ($idx -lt 1) { continue }
  $conf[$trimmed.Substring(0, $idx).Trim()] = $trimmed.Substring($idx + 1).Trim()
}
foreach ($required in @('SEPOLIA_RPC_URL', 'BLOCKCHAIN_CONFIRMATIONS', 'BLOCKCHAIN_RECEIPT_TIMEOUT_MS', 'BLOCKCHAIN_SIGNER_KEY_FILE', 'BLOCKCHAIN_TREASURY_SIGNER_KEY_FILE')) {
  if (-not $conf[$required]) { Fail "$required is missing from $ConfigPath" }
}

# --- deployment record -------------------------------------------------------
if (-not (Test-Path $DeploymentRecord)) {
  Fail "no deployment record at $DeploymentRecord - run 'npm run deploy:sepolia' in blockchain/ first (nothing is deployed yet)."
}
$record = Get-Content $DeploymentRecord -Raw | ConvertFrom-Json
if ($record.network -ne 'sepolia') { Fail "record network '$($record.network)' is not 'sepolia'" }
if ([int]$record.chainId -eq 1) { Fail "chain id 1 (mainnet) is never allowed" }
if ([int]$record.chainId -ne $EXPECTED_CHAIN_ID) { Fail "record chain id $($record.chainId) is not $EXPECTED_CHAIN_ID" }
if (-not $record.tokenAddress -or -not $record.treasuryAddress) { Fail "record lacks tokenAddress/treasuryAddress" }

# --- live RPC agrees with the record ----------------------------------------
$rpcUrl = $conf['SEPOLIA_RPC_URL']
$liveHex = Invoke-Eth $rpcUrl 'eth_chainId' @()
$liveChainId = [Convert]::ToInt32($liveHex, 16)
if ($liveChainId -ne $EXPECTED_CHAIN_ID) {
  Fail "RPC $rpcUrl reports chain id $liveChainId, expected $EXPECTED_CHAIN_ID - refusing to switch environments"
}
$code = Invoke-Eth $rpcUrl 'eth_getCode' @($record.tokenAddress, 'latest')
if (-not $code -or $code -eq '0x') {
  Fail "token $($record.tokenAddress) has NO bytecode at the live RPC - deployment record is not verifiable on-chain"
}

# --- key files exist and belong to the recorded signers ---------------------
$minterKey = $conf['BLOCKCHAIN_SIGNER_KEY_FILE']
$treasuryKey = $conf['BLOCKCHAIN_TREASURY_SIGNER_KEY_FILE']
foreach ($kf in @($minterKey, $treasuryKey)) {
  if (-not (Test-Path $kf)) { Fail "signer key file '$kf' does not exist" }
}
Push-Location $blockchainRoot
try {
  $derivedJson = node scripts/derive-address.js $minterKey $treasuryKey
  if ($LASTEXITCODE -ne 0) { Fail "could not derive addresses from the key files" }
} finally {
  Pop-Location
}
$derived = $derivedJson | ConvertFrom-Json
if ($derived[0].address -ne $record.minterAddress) {
  Fail "minter key file holds $($derived[0].address) but the record says $($record.minterAddress)"
}
if ($derived[1].address -ne $record.treasuryAddress) {
  Fail "treasury key file holds $($derived[1].address) but the record says $($record.treasuryAddress)"
}

# --- inject BLOCKCHAIN_* into the process environment only -------------------
$env:BLOCKCHAIN_ENABLED = 'true'
$env:BLOCKCHAIN_NETWORK = 'sepolia'
$env:BLOCKCHAIN_CHAIN_ID = [string]$EXPECTED_CHAIN_ID
$env:BLOCKCHAIN_RPC_URL = $rpcUrl
$env:BLOCKCHAIN_TOKEN_ADDRESS = [string]$record.tokenAddress
$env:BLOCKCHAIN_TREASURY_ADDRESS = [string]$record.treasuryAddress
$env:BLOCKCHAIN_EMBER_MAX_SUPPLY = [string]$record.maxSupplyWhole
$env:BLOCKCHAIN_DEPLOYMENT_BLOCK = [string]$record.blockNumber
$env:BLOCKCHAIN_CONFIRMATIONS = $conf['BLOCKCHAIN_CONFIRMATIONS']
$env:BLOCKCHAIN_RECEIPT_TIMEOUT_MS = $conf['BLOCKCHAIN_RECEIPT_TIMEOUT_MS']
$env:BLOCKCHAIN_SIGNER_KEY_FILE = $minterKey
$env:BLOCKCHAIN_TREASURY_SIGNER_KEY_FILE = $treasuryKey

Write-Host ''
Write-Host 'Sepolia backend configuration verified:' -ForegroundColor Green
Write-Host "  chain id      : $EXPECTED_CHAIN_ID (live RPC agrees)"
Write-Host "  token         : $($record.tokenAddress)"
Write-Host "  treasury      : $($record.treasuryAddress)"
Write-Host "  minter        : $($record.minterAddress)"
Write-Host "  deploy block  : $($record.blockNumber)"
Write-Host "  confirmations : $($conf['BLOCKCHAIN_CONFIRMATIONS'])"
Write-Host "  rpc           : $rpcUrl"
Write-Host "  backend .env  : untouched (local mode still works)"
Write-Host ''

if ($SkipRun) {
  Write-Host '-SkipRun: pre-flight passed; environment not started.'
  exit 0
}

Push-Location $backendRoot
try {
  npm run $Command
} finally {
  Pop-Location
}
