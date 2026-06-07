$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\jpurc\RogueZero'
$path = 'services\worker\src\index.ts'
$src = [System.IO.File]::ReadAllText($path)

$nl = "`r`n"

$old1 = 'const WORKER_MAX_CONSECUTIVE_LOSSES = Number(process.env.WORKER_MAX_CONSECUTIVE_LOSSES ?? 2);'
$new1 = '// FORCED-SELL BRAKE. The time-decay take-profit ladder lowers a position''s take-' + $nl +
        '// profit target toward the cost floor as it ages, which DUMPS green-but-stuck' + $nl +
        '// bags near breakeven-minus-fees -- a forced loss exit. Disabled by default so' + $nl +
        '// winners ride the trailing stop instead of being force-sold flat. Set true to' + $nl +
        '// re-enable the decay ladder.' + $nl +
        'const WORKER_TP_TIME_DECAY_ENABLED = process.env.WORKER_TP_TIME_DECAY_ENABLED === ''true'';' + $nl +
        $old1

$old2 = '    if (decayFullMs <= decayStartMs || positionAgeMs <= decayStartMs || rawTakeProfitBps <= costFloorBps) {'
$new2 = '    if (!WORKER_TP_TIME_DECAY_ENABLED || decayFullMs <= decayStartMs || positionAgeMs <= decayStartMs || rawTakeProfitBps <= costFloorBps) {'

$c1 = ([regex]::Matches($src, [regex]::Escape($old1))).Count
$c2 = ([regex]::Matches($src, [regex]::Escape($old2))).Count
Write-Host "anchor1 matches: $c1 ; anchor2 matches: $c2"

if ($c1 -eq 1 -and $c2 -eq 1) {
    $src = $src.Replace($old1, $new1).Replace($old2, $new2)
    [System.IO.File]::WriteAllText($path, $src)
    Write-Host "APPLIED. lines now: $((Get-Content $path | Measure-Object -Line).Lines)"
    Write-Host "flag present: $((Select-String -Path $path -Pattern 'WORKER_TP_TIME_DECAY_ENABLED').Count)"
} else {
    Write-Host "ABORTED - anchors not unique"
}
