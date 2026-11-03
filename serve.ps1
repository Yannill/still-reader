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
