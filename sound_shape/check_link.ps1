# 声音的形状 · 链路体检
# 一次检查五段链路，告诉你断在哪一段。
#
#   powershell -ExecutionPolicy Bypass -File check_link.ps1
#   powershell -ExecutionPolicy Bypass -File check_link.ps1 -Port COM5

param(
  [string]$Port = "",
  [int]$Baud = 115200,
  [string]$Api = "http://127.0.0.1:5000",
  [int]$ListenSeconds = 4
)

$results = @()
function Add-Result($n, $name, $ok, $detail, $fix) {
  $script:results += [pscustomobject]@{ No = $n; Name = $name; Ok = $ok; Detail = $detail; Fix = $fix }
}

Write-Host ""
Write-Host "  声音的形状 · 链路体检" -ForegroundColor Cyan
Write-Host "  ────────────────────────────────────────────"

# ---------------------------------------------------------------- ① 后端
$health = $null
try {
  $health = Invoke-RestMethod -Uri "$Api/api/health" -TimeoutSec 3
  Add-Result 1 "后端服务" $true ("已启动 v" + $health.version) ""
} catch {
  Add-Result 1 "后端服务" $false "连不上 $Api" "先运行 start_server.bat"
}

# ---------------------------------------------------------------- ② 串口
$ports = [System.IO.Ports.SerialPort]::GetPortNames()
if (-not $Port) {
  if ($ports.Count -ge 1) { $Port = $ports[0] }
}

if ($ports.Count -eq 0) {
  Add-Result 2 "串口设备" $false "系统里没有任何 COM 口" "插好 ESP32 的 USB 线；CH340 芯片要装驱动"
} else {
  Add-Result 2 "串口设备" $true (($ports -join ", ") + "   当前用 " + $Port) ""
}

# ---------------------------------------------------------------- ③ 串口有没有数据
$heard = @()
$portBusy = $false
if ($ports.Count -gt 0 -and $Port) {
  $sp = New-Object System.IO.Ports.SerialPort
  $sp.PortName = $Port
  $sp.BaudRate = $Baud
  $sp.Parity = [System.IO.Ports.Parity]::None
  $sp.DataBits = 8
  $sp.StopBits = [System.IO.Ports.StopBits]::One
  $sp.NewLine = "`n"
  $sp.ReadTimeout = 500
  $sp.Encoding = [System.Text.Encoding]::UTF8

  $opened = $false
  try { $sp.Open(); $opened = $true } catch { $portBusy = $true }

  if ($opened) {
    $deadline = (Get-Date).AddSeconds($ListenSeconds)
    while ((Get-Date) -lt $deadline) {
      try {
        $line = $sp.ReadLine().Trim()
        if ($line) { $heard += $line }
      } catch [System.TimeoutException] { }
      catch { break }
      if ($heard.Count -ge 60) { break }
    }
    try { $sp.Close() } catch {}
  }

  $jsonCount = ($heard | Where-Object { $_.StartsWith("{") }).Count

  if ($portBusy) {
    Add-Result 3 "串口有数据" $true ("$Port 被占用（多半是桥在跑，正常）") ""
  } elseif (-not $opened) {
    Add-Result 3 "串口有数据" $false ("打不开 $Port") "关掉 Arduino 串口监视器；或换个 COM 口"
  } elseif ($heard.Count -eq 0) {
    Add-Result 3 "串口有数据" $false ("$ListenSeconds 秒内没收到任何字节") "板子可能没在跑，或波特率不是 $Baud；按一下复位键"
  } elseif ($jsonCount -eq 0) {
    Add-Result 3 "串口有数据" $false ("收到 $($heard.Count) 行，但没有 JSON 事件") "固件可能是旧版；重新烧录带 hello 事件的版本"
  } else {
    $sample = ($heard | Where-Object { $_.StartsWith("{") } | Select-Object -First 1)
    Add-Result 3 "串口有数据" $true ("收到 $jsonCount 条 JSON，例如 " + $sample.Substring(0, [Math]::Min(60, $sample.Length))) ""
  }
} else {
  Add-Result 3 "串口有数据" $false "没有可用串口" "插好板子再试"
}

# ---------------------------------------------------------------- ④ 后端有没有收到硬件
if ($health) {
  try { $health = Invoke-RestMethod -Uri "$Api/api/health" -TimeoutSec 3 } catch {}
  $d = $health.device
  if ($d -and $d.online) {
    Add-Result 4 "后端收到硬件" $true ("$($d.lastSeenSeconds) 秒前收到 " + $d.lastEvent + "（累计 " + $d.events + " 条）") ""
  } elseif ($d -and $d.lastSeenSeconds -ne $null) {
    Add-Result 4 "后端收到硬件" $false ("最后一次是 " + $d.lastSeenSeconds + " 秒前，太久了") "确认桥还在跑；板子重启过就等一条 hello"
  } else {
    Add-Result 4 "后端收到硬件" $false "从没收到过硬件上报" "start_bridge.bat 有没有在跑？"
  }
} else {
  Add-Result 4 "后端收到硬件" $false "后端没起，无法判断" "先启动后端"
}

# ---------------------------------------------------------------- ⑤ 大屏有没有连上
if ($health) {
  $clients = 0
  if ($null -ne $health.wsClients) { $clients += [int]$health.wsClients }
  if ($null -ne $health.sseClients) { $clients += [int]$health.sseClients }
  if ($clients -gt 0) {
    Add-Result 5 "大屏已连接" $true ("$clients 个客户端在线") ""
  } else {
    Add-Result 5 "大屏已连接" $false "没有客户端连着后端" "浏览器打开 $Api/ 并刷新"
  }
} else {
  Add-Result 5 "大屏已连接" $false "后端没起，无法判断" "先启动后端"
}

# ---------------------------------------------------------------- 输出
Write-Host ""
foreach ($r in $results) {
  if ($r.Ok) {
    Write-Host ("  {0}  {1,-14} " -f $r.No, $r.Name) -NoNewline -ForegroundColor DarkGray
    Write-Host " OK  " -NoNewline -ForegroundColor Green
    Write-Host $r.Detail
  } else {
    Write-Host ("  {0}  {1,-14} " -f $r.No, $r.Name) -NoNewline -ForegroundColor DarkGray
    Write-Host " 断  " -NoNewline -ForegroundColor Red
    Write-Host $r.Detail -ForegroundColor Yellow
    if ($r.Fix) { Write-Host ("        → " + $r.Fix) -ForegroundColor DarkGray }
  }
}

Write-Host ""
$bad = ($results | Where-Object { -not $_.Ok }).Count
if ($bad -eq 0) {
  Write-Host "  全链路正常。对着板子拍一下手，大屏应该跳出名字。" -ForegroundColor Green
} else {
  Write-Host ("  有 " + $bad + " 段没通，按上面的 → 提示排查。") -ForegroundColor Yellow
}
Write-Host ""
