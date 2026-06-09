$ErrorActionPreference = "Stop"
$path = "services\worker\src\index.ts"
$text = [System.IO.File]::ReadAllText($path)

$oldMints = "const TOKEN_UNIVERSE_HARD_BLOCKED_MINTS = new Set<string>([`r`n  '4SZjjNABoqhbd4hnapbvoEPEqT8mnNkfbEoAwALf1V8t', // CAVE`r`n]);"
$newMints = "const TOKEN_UNIVERSE_HARD_BLOCKED_MINTS = new Set<string>([`r`n  '4SZjjNABoqhbd4hnapbvoEPEqT8mnNkfbEoAwALf1V8t', // CAVE`r`n  // Net money-losers over trailing 30d (exit_shadow_decisions). Removed from`r`n  // the live entry universe because they bleed the SOL/JTO/JUP edge:`r`n  'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5', // MEW  -153 bps`r`n  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // MSOL -115 bps`r`n  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', // W    -94 bps`r`n  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK -30 bps`r`n]);"

$oldSyms = "const TOKEN_UNIVERSE_HARD_BLOCKED_SYMBOLS = new Set<string>([`r`n  'CAVE',`r`n  'APPLE',`r`n  'USELESS',`r`n]);"
$newSyms = "const TOKEN_UNIVERSE_HARD_BLOCKED_SYMBOLS = new Set<string>([`r`n  'CAVE',`r`n  'APPLE',`r`n  'USELESS',`r`n  'MEW',`r`n  'MSOL',`r`n  'W',`r`n  'BONK',`r`n]);"

$cM = ([regex]::Matches($text, [regex]::Escape($oldMints))).Count
if ($cM -ne 1) { throw "MINTS match count = $cM (expected 1)" }
$text = $text.Replace($oldMints, $newMints)

$cS = ([regex]::Matches($text, [regex]::Escape($oldSyms))).Count
if ($cS -ne 1) { throw "SYMS match count = $cS (expected 1)" }
$text = $text.Replace($oldSyms, $newSyms)

[System.IO.File]::WriteAllText($path, $text)
Write-Host "OK: hard-block updated (mints+symbols)"
