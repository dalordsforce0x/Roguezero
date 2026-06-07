param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\jpurc\RogueZero'

$p = "c:\Users\jpurc\AppData\Roaming\Code\User\workspaceStorage\03adfa1a0aec76e85a76fc4a3d5c4038\GitHub.copilot-chat\transcripts\2bac01f2-ba22-4348-a5ad-a6a259d47a1c.jsonl"
$srcPath = "services\worker\src\index.ts"

$line = (Get-Content $p)[44832 - 1]
$j = $line | ConvertFrom-Json
$reps = ($j.data.toolRequests[0].arguments | ConvertFrom-Json).replacements

$src = [System.IO.File]::ReadAllText($srcPath)

function ConvertTo-CRLF([string]$s) {
    return (($s -replace "`r`n", "`n") -replace "`n", "`r`n")
}

$ok = $true
$prepared = @()
foreach ($rep in $reps) {
    $old = ConvertTo-CRLF $rep.oldString
    $new = ConvertTo-CRLF $rep.newString
    $count = ([regex]::Matches($src, [regex]::Escape($old))).Count
    Write-Host "match count (old len $($old.Length), new len $($new.Length)): $count"
    if ($count -ne 1) { $ok = $false }
    $prepared += [pscustomobject]@{ Old = $old; New = $new; Count = $count }
}

Write-Host "ALL UNIQUE: $ok"

if ($Apply -and $ok) {
    foreach ($pr in $prepared) {
        $src = $src.Replace($pr.Old, $pr.New)
    }
    [System.IO.File]::WriteAllText($srcPath, $src)
    Write-Host "APPLIED. New file size: $((Get-Item $srcPath).Length) bytes"
}
elseif ($Apply -and -not $ok) {
    Write-Host "NOT APPLIED - anchors not unique."
}
