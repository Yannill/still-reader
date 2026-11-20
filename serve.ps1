# 零依赖本地服务器（Windows 自带 PowerShell 即可运行）
# 用法：powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080]
# 正式版请使用 C++ 服务器（cpp/ 目录，带 AI 代理），这里只是方便没有编译环境时演示。
param([int]$Port = 8080, [switch]$NoBrowser)

$root = Join-Path $PSScriptRoot 'web'
$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.pdf' = 'application/pdf'; '.wasm' = 'application/wasm'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.svg' = 'image/svg+xml'; '.ico' = 'image/x-icon'
  '.bcmap' = 'application/octet-stream'; '.pfb' = 'application/octet-stream'; '.ttf' = 'font/ttf'
  '.woff2' = 'font/woff2'
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try { $listener.Start() } catch { Write-Host "端口 $Port 被占用，换一个：serve.ps1 -Port 8090" -ForegroundColor Red; exit 1 }
Write-Host "专注阅读已启动：http://localhost:$Port/   （Ctrl+C 停止）" -ForegroundColor Green
if (-not $NoBrowser) { Start-Process "http://localhost:$Port/" }

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    try {
      $path = [Uri]::UnescapeDataString($req.Url.AbsolutePath)
      if ($path -eq '/api/ai/chat' -and $req.HttpMethod -eq 'POST') {
        $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        $payload = $reader.ReadToEnd() | ConvertFrom-Json
        $target = [string]$payload.url
        if ($target -notmatch '^https://' -or $target -match '^https://(localhost|127\.|10\.|192\.168\.|169\.254\.)') {
          $res.StatusCode = 400
          $b = [Text.Encoding]::UTF8.GetBytes('{"error":{"message":"Invalid target URL"}}')
          $res.ContentType = 'application/json; charset=utf-8'
          $res.OutputStream.Write($b, 0, $b.Length)
        } else {
          $bodyObj = $payload.body
          if ($bodyObj.PSObject.Properties['stream']) { $bodyObj.stream = $false }
          $jsonBytes = [Text.Encoding]::UTF8.GetBytes(($bodyObj | ConvertTo-Json -Depth 20 -Compress))
          $hreq = [System.Net.HttpWebRequest]::Create($target)
          $hreq.Method = 'POST'
          $hreq.ContentType = 'application/json; charset=utf-8'
          if ($payload.apiKey) { $hreq.Headers.Add('Authorization', 'Bearer ' + [string]$payload.apiKey) }
          $hreq.Timeout = 60000
          $hreq.ContentLength = $jsonBytes.Length
          $rs = $hreq.GetRequestStream(); $rs.Write($jsonBytes, 0, $jsonBytes.Length); $rs.Close()
          try {
            $hres = $hreq.GetResponse()
            $res.StatusCode = [int]$hres.StatusCode
            $res.ContentType = if ($hres.ContentType) { $hres.ContentType } else { 'application/json; charset=utf-8' }
            $ms = New-Object IO.MemoryStream
            $hres.GetResponseStream().CopyTo($ms)
            $out = $ms.ToArray()
            $res.ContentLength64 = $out.Length
            $res.OutputStream.Write($out, 0, $out.Length)
            $hres.Close()
          } catch [System.Net.WebException] {
            $errRes = $_.Exception.Response
            if ($errRes) {
              $res.StatusCode = [int]$errRes.StatusCode
              $res.ContentType = if ($errRes.ContentType) { $errRes.ContentType } else { 'application/json; charset=utf-8' }
              $ms = New-Object IO.MemoryStream
              $errRes.GetResponseStream().CopyTo($ms)
              $out = $ms.ToArray()
              $res.ContentLength64 = $out.Length
              $res.OutputStream.Write($out, 0, $out.Length)
              $errRes.Close()
            } else {
              $res.StatusCode = 502
              $b = [Text.Encoding]::UTF8.GetBytes(('{"error":{"message":' + ($_.Exception.Message | ConvertTo-Json) + '}}'))
              $res.ContentType = 'application/json; charset=utf-8'
              $res.OutputStream.Write($b, 0, $b.Length)
            }
          }
        }
        continue
      }
      if ($path -eq '/') { $path = '/index.html' }
      $file = [IO.Path]::GetFullPath((Join-Path $root $path.TrimStart('/')))
      if (-not $file.StartsWith([IO.Path]::GetFullPath($root)) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $res.StatusCode = 404
        $b = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
        $res.OutputStream.Write($b, 0, $b.Length)
      } else {
        $ext = [IO.Path]::GetExtension($file).ToLower()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.AddHeader('Cache-Control', 'no-cache')
        $bytes = [IO.File]::ReadAllBytes($file)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    } catch { $res.StatusCode = 500 } finally { $res.OutputStream.Close() }
  }
} finally { $listener.Stop() }
