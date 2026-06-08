$ErrorActionPreference = "Stop"
# Mirror the exact frontend createSession() request: hit the roguezero.io proxy
# (which injects the internal secret server-side, like the browser path) with the
# real DEFAULT_SESSION_REQUEST UI settings and licenseId = user.id.
$body = @{
  userId             = "54d9f25d-9526-4eb9-8e6b-9cb649a97d88"
  keyAuthUserId      = "54d9f25d-9526-4eb9-8e6b-9cb649a97d88"
  licenseId          = "54d9f25d-9526-4eb9-8e6b-9cb649a97d88"
  ownerWallet        = "7cAgVZajnv3BwLdF8wiirSD9E9HC1PHJ7bfFgRzLC92q"
  fundingMint        = "So11111111111111111111111111111111111111112"
  fundingTokenSymbol = "SOL"
  startingBalanceAtomic = "0"
  stopLossBehavior   = "stop"
  riskLimits = @{
    maxSessionLossUsd = 50
    maxDailyLossUsd   = 100
    maxPositionSizeUsd = 1000
    maxOpenPositions  = 10
    maxSlippageBps    = 50
    cooldownMs        = 30000
  }
} | ConvertTo-Json -Depth 6
try {
  $r = Invoke-WebRequest -Uri "https://roguezero.io/api/rz/sessions" -Method POST -Headers @{ "Content-Type"="application/json" } -Body $body -TimeoutSec 30 -UseBasicParsing
  Write-Output ("HTTP " + $r.StatusCode)
  Write-Output $r.Content
} catch {
  Write-Output ("ERR: " + $_.Exception.Message)
  if ($_.Exception.Response) {
    $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    Write-Output $sr.ReadToEnd()
  }
}
