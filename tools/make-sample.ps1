# Generates web/samples/sample.pdf (2 pages, real text) for testing. ASCII only.
$out = Join-Path $PSScriptRoot '..\web\samples\sample.pdf'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null

$para = @(
  'Attention is a limited resource. When we read, the eyes jump between lines,',
  'and a reader with ADHD may lose the current line many times per page.',
  'A focus lens keeps one line sharp and fades the rest of the page, so the',
  'brain has only one small thing to do at a time: read this line, then the next.',
  '',
  'Short feedback loops also matter. Seeing progress, getting a gentle reminder',
  'to take a break, and parking distracting thoughts in a list can turn reading',
  'from a heavy task into a series of small, finishable steps.',
  '',
  'Translation and explanations should appear right below the sentence, not in',
  'another window. Every switch of context is a chance to get distracted.'
)

function PageStream([string]$title, [string[]]$lines) {
  $s = "BT /F1 22 Tf 72 740 Td ($title) Tj ET`n"
  $y = 700
  foreach ($l in $lines) {
    if ($l -ne '') { $s += "BT /F1 12 Tf 72 $y Td ($l) Tj ET`n" }
    $y -= 20
  }
  return $s
}

$s1 = PageStream 'Reading with ADHD: A Short Guide' $para
$s2 = PageStream 'Chapter 2: Practical Tips' ($para | Select-Object -Skip 5) 

$objs = @(
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  "<< /Length $($s1.Length) >>`nstream`n$s1`nendstream",
  "<< /Length $($s2.Length) >>`nstream`n$s2`nendstream"
)

$sb = New-Object System.Text.StringBuilder
[void]$sb.Append("%PDF-1.4`n")
$offsets = @()
for ($i = 0; $i -lt $objs.Count; $i++) {
  $offsets += $sb.Length
  [void]$sb.Append("$($i + 1) 0 obj`n$($objs[$i])`nendobj`n")
}
$xref = $sb.Length
[void]$sb.Append("xref`n0 $($objs.Count + 1)`n0000000000 65535 f `n")
foreach ($o in $offsets) { [void]$sb.Append(('{0:D10} 00000 n `n' -f $o)) }
[void]$sb.Append("trailer`n<< /Size $($objs.Count + 1) /Root 1 0 R >>`nstartxref`n$xref`n%%EOF`n")
[IO.File]::WriteAllText($out, $sb.ToString(), [Text.Encoding]::ASCII)
Write-Host "written: $out"
