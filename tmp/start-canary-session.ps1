$ErrorActionPreference = "Stop"
# Mirror the browser modal's "Save and Start": PATCH the session action via the
# roguezero.io proxy (injects the internal secret server-side) with action=start
# and the chosen profit handling.
$sessionId = $args[0]
$mode      = $args[1]   # send_to_owner | compound
$token     = $args[2]   # SOL | USDC
if (-not $sessionId) { Write-Output "usage: start-canary-session.ps1 <sessionId> <mode> <token>"; exit 1 }

$body = @{
  action            = "start"
  profitMode        = $mode
  profitPayoutToken = $token
  clientActionSource = "verify-passthrough:start"
} | ConvertTo-Json -Depth 4

try {
  $r = Invoke-WebRequest -Uri "https://roguezero.io/api/rz/sessions/$sessionId/action" -Method PATCH -Headers @{ "Content-Type"="application/json" } -Body $body -TimeoutSec 30 -UseBasicParsing
  Write-Output ("HTTP " + $r.StatusCode)
  Write-Output $r.Content
} catch {
  Write-Output ("ERR: " + $_.Exception.Message)
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output $sr.ReadToEnd()
  }
}
