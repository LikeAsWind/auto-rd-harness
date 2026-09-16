# Converts persona template literals to array.join form.
# Usage: .\convert-personas.ps1 <file>
#
# Strategy:
# 1. Find `readonly persona = \`...\` ;` (the template literal)
# 2. Split into lines
# 3. Wrap each line in `'...'`, (or empty string for blanks)
# 4. Join with ',\n'
# 5. Replace the original
#
# Note: This script does NOT handle lines containing single-quotes that would
# need escaping. It assumes the persona body has no unescaped single quotes.
# If the body does have single quotes, manual fixing is required afterwards.

param([string]$Path)

$content = [System.IO.File]::ReadAllText($Path)

# Match the persona block. The persona body may span multiple lines.
# Pattern: `  readonly persona = `...` ;` (template literal body multiline)
$pattern = '(?s)(readonly persona = )`(.+?)`(\s*;?\s*\r?\n)'
$match = [regex]::Match($content, $pattern)
if (-not $match.Success) {
    Write-Host "No persona template literal found in $Path"
    return
}

$prefix = $match.Groups[1].Value
$body = $match.Groups[2].Value
$suffix = $match.Groups[3].Value

# Split body into lines, preserving empty lines.
$lines = $body -split "`r?`n"

# Convert each line: replace any backticks with a placeholder (none needed;
## we're switching to single-quoted strings which can hold backticks raw).
# Escape single quotes by doubling them.
$escapedLines = $lines | ForEach-Object {
    if ($_ -eq '') {
        "    ''"
    } else {
        $escaped = $_ -replace "'", "''"
        "    '$escaped'"
    }
}

$arrayLiteral = "[\r\n" + ($escapedLines -join ",\r\n") + ",\r\n  ].join('\n')"

$replacement = $prefix + $arrayLiteral + $suffix
$newContent = $content.Substring(0, $match.Index) + $replacement + $content.Substring($match.Index + $match.Length)

[System.IO.File]::WriteAllText($Path, $newContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "Converted persona in $Path"