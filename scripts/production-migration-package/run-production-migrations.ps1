[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('YES')]
  [string]$BackupConfirmed,

  [string]$PsqlPath = 'psql.exe',

  [string]$ProductionDatabaseUrl = "postgresql://postgres.xpvnrbllqdhzmockmkmx:yNIKX0UbW4fqGisD@aws-1-ap-south-1.pooler.supabase.com:6543/postgres"
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($ProductionDatabaseUrl)) {
  throw 'PRODUCTION_DATABASE_URL is required for this process only. Do not put credentials in this script or source control.'
}
if (-not (Get-Command $PsqlPath -ErrorAction SilentlyContinue)) {
  throw "psql was not found: $PsqlPath"
}

$packageRoot = $PSScriptRoot
$repositoryRoot = Split-Path -Parent (Split-Path -Parent $packageRoot)
$migrationRoot = Join-Path $repositoryRoot 'migrations'
$preflight = Join-Path $packageRoot 'preflight.sql'
$postverify = Join-Path $packageRoot 'postverify.sql'

# This is intentionally the exact clone-rehearsed APPLY manifest. Skipped
# migrations are documented in README.md and are never invoked by this runner.
$applyMigrations = @(
  '20260921_add_address_tenant_customer_index.sql',
  '20260922_add_customer_directory_index.sql',
  '20260926_add_review_invitation_submission_uniqueness.sql',
  '20260927_add_enquiry_customer_ownership.sql',
  '20260928_add_auth_customer_uniqueness.sql',
  '20260929_add_checkout_sessions.sql',
  '20260930_add_checkout_email_verifications.sql',
  '20261001_add_shipping_settings.sql',
  '20261002_add_order_operations.sql',
  '20261003_add_customer_auth_verifications.sql',
  '20261004_add_inventory_transactions.sql',
  '20261005_add_unified_notifications.sql',
  '20261006_add_dashboard_aggregate_indexes.sql',
  '20261007_add_audit_and_http_observability.sql',
  '20261008_add_razorpay_webhook_events.sql',
  '20261009_add_payment_reconciliations.sql',
  '20261010_add_payment_attempt_events.sql',
  '20261011_add_purchase_order_item_reviews.sql',
  '20261012_add_homepage_testimonials.sql',
  '20261013_refine_homepage_testimonials.sql',
  '20261014_add_notification_delivery_audit.sql',
  '20261015_add_enquiry_references.sql'
)

function Invoke-PsqlFile([string]$FilePath, [string[]]$ExtraArguments = @()) {
  & $PsqlPath -X -v 'ON_ERROR_STOP=1' -d $ProductionDatabaseUrl @ExtraArguments -f $FilePath
  if ($LASTEXITCODE -ne 0) { throw "psql failed for $FilePath (exit code $LASTEXITCODE). No later migration was run." }
}

function Get-Baseline {
  $sql = @'
SELECT json_build_object(
  'products', (SELECT count(*) FROM products),
  'customers', (SELECT count(*) FROM customers),
  'orders', (SELECT count(*) FROM orders),
  'order_items', (SELECT count(*) FROM order_items),
  'payments', (SELECT count(*) FROM payments),
  'enquiries', (SELECT count(*) FROM enquiries),
  'pending_confirmed_orders', (SELECT count(*) FROM orders WHERE payment_status = 'PENDING' AND status = 'CONFIRMED')
)::text;
'@
  $json = & $PsqlPath -X -v 'ON_ERROR_STOP=1' -qAt -d $ProductionDatabaseUrl -c $sql
  if ($LASTEXITCODE -ne 0) { throw "Could not capture the production baseline (exit code $LASTEXITCODE)." }
  return ($json | ConvertFrom-Json)
}

try {
  Write-Host 'Running read-only manifest and data preflight...'
  Invoke-PsqlFile $preflight

  $baseline = Get-Baseline
  $baselinePath = Join-Path $packageRoot ("production-baseline-{0}.json" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $baseline | ConvertTo-Json | Set-Content -LiteralPath $baselinePath -Encoding UTF8
  Write-Host "Captured execution-time baseline in $baselinePath"

  foreach ($migration in $applyMigrations) {
    $migrationPath = Join-Path $migrationRoot $migration
    if (-not (Test-Path -LiteralPath $migrationPath -PathType Leaf)) { throw "Missing migration file: $migrationPath" }
    Write-Host "APPLYING $migration"
    Invoke-PsqlFile $migrationPath
    Write-Host "APPLIED $migration"
  }

  Write-Host 'Running post-migration verification...'
  $verifyArgs = @(
    '-v', "baseline_products=$($baseline.products)",
    '-v', "baseline_customers=$($baseline.customers)",
    '-v', "baseline_orders=$($baseline.orders)",
    '-v', "baseline_order_items=$($baseline.order_items)",
    '-v', "baseline_payments=$($baseline.payments)",
    '-v', "baseline_enquiries=$($baseline.enquiries)",
    '-v', "baseline_pending_confirmed_orders=$($baseline.pending_confirmed_orders)"
  )
  Invoke-PsqlFile $postverify $verifyArgs
  Write-Host 'SUCCESS: production migration manifest and postchecks completed.'
}
catch {
  Write-Error $_
  exit 1
}
