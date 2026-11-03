# Headless Chrome test harness via DevTools Protocol (ASCII only, no dependencies).
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\cdp.ps1 -Url http://localhost:8080/ -StepsFile steps.js -Out C:\tmp\run
# steps.js: JS snippets separated by lines starting with  //---  (each may be async / return a value).
# A line  //--- wait 1500  waits 1500 ms before the next snippet. Each snippet result + a screenshot is saved.
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$StepsFile = '',
  [string]$Out = "$env:TEMP\kilo\cdp",
  [int]$LoadWait = 4000,
  [int]$Width = 1440, [int]$Height = 900,
  [string]$Chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Get-ChildItem $Out -Filter 'shot*.png' -ErrorAction SilentlyContinue | Remove-Item -Force
$port = 9300 + (Get-Random -Maximum 500)
$ud = Join-Path $env:TEMP ("kilo\cdp-ud-" + (Get-Random))
$proc = Start-Process -FilePath $Chrome -WindowStyle Hidden -PassThru -ArgumentList @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  "--remote-debugging-port=$port", '--remote-allow-origins=*', "--user-data-dir=$ud", "--window-size=$Width,$Height", 'about:blank')

$ws = $null
try {
  $target = $null
  for ($i = 0; $i -lt 50 -and -not $target; $i++) {
    Start-Sleep -Milliseconds 200
    try { $target = (Invoke-RestMethod "http://127.0.0.1:$port/json") | Where-Object { $_.type -eq 'page' } | Select-Object -First 1 } catch {}
  }
  if (-not $target) { throw 'chrome devtools not reachable' }

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(20)
  try { $ws.Options.Proxy = $null } catch {}
  try { $ws.ConnectAsync([Uri]$target.webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait() }
  catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; throw "ws connect failed ($($target.webSocketDebuggerUrl)): $($e.Message)" }
  $script:msgId = 0
  $script:pending = New-Object System.Collections.ArrayList
  $script:logs = New-Object System.Collections.ArrayList
  $buf = New-Object byte[] 1048576

  function Send-Raw($method, $params) {
    $script:msgId++
    $obj = @{ id = $script:msgId; method = $method; params = $(if ($params) { $params } else { @{} }) }
    $json = $obj | ConvertTo-Json -Depth 20 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $ws.SendAsync((New-Object ArraySegment[byte] -ArgumentList @(, $bytes)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
    return $script:msgId
  }
  $script:recvTask = $null
  $script:msgBuf = New-Object IO.MemoryStream
  # Keeps an outstanding ReceiveAsync across timeouts (only one may be pending at a time).
  function Receive-One([int]$timeoutMs) {
    while ($true) {
      if (-not $script:recvTask) {
        $seg = New-Object ArraySegment[byte] -ArgumentList @(, $buf)
        $script:recvTask = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None)
      }
      try { $ok = $script:recvTask.Wait($timeoutMs) }
      catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; throw "ws receive failed: $($e.Message)" }
      if (-not $ok) { return $null }
      $res = $script:recvTask.Result
      $script:recvTask = $null
      $script:msgBuf.Write($buf, 0, $res.Count)
      if ($res.EndOfMessage) {
        $txt = [Text.Encoding]::UTF8.GetString($script:msgBuf.ToArray())
        $script:msgBuf.SetLength(0)
        return ($txt | ConvertFrom-Json)
      }
    }
  }
  function Handle-Event($m) {
    if ($m.method -eq 'Runtime.consoleAPICalled') {
      $txt = ($m.params.args | ForEach-Object { if ($null -ne $_.value) { "$($_.value)" } elseif ($_.description) { $_.description } else { $_.type } }) -join ' '
      [void]$script:logs.Add("[console.$($m.params.type)] $txt")
    } elseif ($m.method -eq 'Runtime.exceptionThrown') {
      $d = $m.params.exceptionDetails
      $desc = if ($d.exception -and $d.exception.description) { $d.exception.description } else { $d.text }
      [void]$script:logs.Add("[EXCEPTION] $desc  @ $($d.url):$($d.lineNumber)")
    } elseif ($m.method -eq 'Log.entryAdded') {
      [void]$script:logs.Add("[log.$($m.params.entry.level)] $($m.params.entry.text) $($m.params.entry.url)")
    }
  }
  function Pump([int]$ms) {
    $end = [DateTime]::Now.AddMilliseconds($ms)
    while ([DateTime]::Now -lt $end) {
      $m = Receive-One 200
      if ($m) { if ($m.method) { Handle-Event $m } else { [void]$script:pending.Add($m) } }
    }
  }
  function Call($method, $params, [int]$timeoutMs = 30000) {
    $id = Send-Raw $method $params
    $end = [DateTime]::Now.AddMilliseconds($timeoutMs)
    while ([DateTime]::Now -lt $end) {
      $hit = $script:pending | Where-Object { $_.id -eq $id } | Select-Object -First 1
      if ($hit) { $script:pending.Remove($hit); return $hit }
      $m = Receive-One 500
      if ($m) { if ($m.method) { Handle-Event $m } elseif ($m.id -eq $id) { return $m } else { [void]$script:pending.Add($m) } }
    }
    throw "timeout: $method"
  }
  function Shot([string]$name) {
    $r = Call 'Page.captureScreenshot' @{ format = 'png' }
    [IO.File]::WriteAllBytes((Join-Path $Out $name), [Convert]::FromBase64String($r.result.data))
  }

  [void](Call 'Runtime.enable' @{})
  [void](Call 'Log.enable' @{})
  [void](Call 'Page.enable' @{})
  [void](Call 'Emulation.setDeviceMetricsOverride' @{ width = $Width; height = $Height; deviceScaleFactor = 1; mobile = $false })
  [void](Call 'Page.navigate' @{ url = $Url })
  Pump $LoadWait
  Shot 'shot0.png'
  Write-Output "== loaded: $Url"

  if ($StepsFile) {
    $raw = [IO.File]::ReadAllText($StepsFile)
    $chunks = [regex]::Split($raw, '(?m)^//---.*$')
    $headers = [regex]::Matches($raw, '(?m)^//---(.*)$') | ForEach-Object { $_.Groups[1].Value.Trim() }
    $n = 0
    for ($i = 0; $i -lt $chunks.Count; $i++) {
      $code = $chunks[$i].Trim()
      if ($code) {
        $n++
        $expr = "(async () => { $code })().then(v => typeof v === 'string' ? v : JSON.stringify(v), e => 'ERROR: ' + (e && e.stack || e))"
        $r = Call 'Runtime.evaluate' @{ expression = $expr; awaitPromise = $true; returnByValue = $true } 60000
        $val = if ($r.result.exceptionDetails) { 'EXCEPTION: ' + $r.result.exceptionDetails.exception.description } else { $r.result.result.value }
        Write-Output "== step $n => $val"
        if ($val -like 'ERROR:*' -or $val -like 'EXCEPTION:*') { throw "step $n failed: $val" }
        Pump 300
        Shot "shot$n.png"
      }
      if ($i -lt $headers.Count -and $headers[$i] -match '^wait\s+(\d+)') { Pump ([int]$Matches[1]) }
    }
  }
  Pump 300
  Write-Output '== console / errors:'
  $script:logs | ForEach-Object { Write-Output $_ }
} finally {
  if ($ws) { try { $ws.Dispose() } catch {} }
  try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
  Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*$ud*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}
