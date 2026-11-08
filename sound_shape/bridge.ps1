# 声音的形状 · 硬件串口桥
# 把 ESP32 从串口打出来的 JSON 事件转发给本机后端，大屏就能实时显示。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bridge.ps1
#   powershell -ExecutionPolicy Bypass -File bridge.ps1 -Port COM5
#
# 固件送上来的事件行（每行一个 JSON）：
#   {"ev":"hello","tpl":3}
#   {"ev":"hit","label":"门铃","conf":0.91,"gap":0.12}
#   {"ev":"miss","label":"水开","conf":0.52}
#   {"ev":"learned","label":"门铃","tpl":4,"bands":[...]}
#   {"ev":"deleted","label":"门铃"}

param(
  [string]$Port = "",
  [int]$Baud = 115200,
  [string]$Api = "http://127.0.0.1:5000"
)

function Say($t) { Write-Host $t }

$ports = [System.IO.Ports.SerialPort]::GetPortNames()

if (-not $Port) {
  if (-not $ports -or $ports.Count -eq 0) {
    Say ""
    Say "  [X] 没有找到串口。"
    Say "      1) 插好 ESP32 的 USB 线"
    Say "      2) 如果板子是 CH340 芯片，先装 CH340 驱动"
    Say "      3) 再运行一次这个脚本"
    Say ""
    Read-Host "按回车退出" | Out-Null
    exit 1
  }
  if ($ports.Count -eq 1) {
    $Port = $ports[0]
  } else {
    Say ""
    Say "  可用串口："
    for ($i = 0; $i -lt $ports.Count; $i++) { Say ("    [{0}] {1}" -f ($i + 1), $ports[$i]) }
    $sel = Read-Host "  选一个（输入序号）"
    $idx = 0
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $ports.Count) {
      Say "  [X] 序号不对"
      Read-Host "按回车退出" | Out-Null
      exit 1
    }
    $Port = $ports[$idx - 1]
  }
}

# 先确认后端在线
try {
  Invoke-RestMethod -Uri "$Api/api/health" -TimeoutSec 3 | Out-Null
  Say ""
  Say "  后端在线：$Api"
} catch {
  Say ""
  Say "  [X] 连不上后端 $Api"
  Say "      先把 start_server.bat 开起来，再运行这个脚本。"
  Say ""
  Read-Host "按回车退出" | Out-Null
  exit 1
}

$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName = $Port
$sp.BaudRate = $Baud
$sp.Parity = [System.IO.Ports.Parity]::None
$sp.DataBits = 8
$sp.StopBits = [System.IO.Ports.StopBits]::One
$sp.NewLine = "`n"
$sp.ReadTimeout = 2000
$sp.Encoding = [System.Text.Encoding]::UTF8   # 固件发的是 UTF-8，不设中文会变问号

try {
  $sp.Open()
} catch {
  Say ""
  Say "  [X] 打不开 $Port ：$($_.Exception.Message)"
  Say "      换个口试试，或关掉 Arduino 串口监视器（它占着串口）。"
  Say ""
  Read-Host "按回车退出" | Out-Null
  exit 1
}

Say ""
Say "  ┌─────────────────────────────────────────────"
Say "  │  硬件已连接：$Port @ $Baud"
Say "  │  转发到：$Api/api/device/event"
Say "  │  保持这个窗口开着。Ctrl+C 退出。"
Say "  └─────────────────────────────────────────────"
Say ""

$ok = 0
$bad = 0

while ($true) {
  $line = $null
  try {
    $line = $sp.ReadLine().Trim()
  } catch [System.TimeoutException] {
    continue
  } catch {
    Say ""
    Say "  [!] 串口断开：$($_.Exception.Message)"
    break
  }

  if (-not $line) { continue }

  if ($line.StartsWith("{")) {
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($line)
      $res = Invoke-RestMethod -Uri "$Api/api/device/event" -Method Post `
               -ContentType "application/json; charset=utf-8" `
               -Body $bytes -TimeoutSec 3
      $ok++
      $tag = "  -> "
      if ($line -match '"ev":"hit"') { $tag = "  HIT  " }
      elseif ($line -match '"ev":"miss"') { $tag = "  miss " }
      elseif ($line -match '"ev":"learned"') { $tag = "  LEARN" }
      elseif ($line -match '"ev":"hello"') { $tag = "  hello" }
      Say ("{0} {1}" -f $tag, $line)
    } catch {
      $bad++
      if ($bad -le 3) {
        Say ("  [!] 转发失败：{0}" -f $_.Exception.Message)
        Say ("      原本要发：{0}" -f $line)
      }
    }
  } else {
    # 固件的调试行，只挑有用的显示
    if ($line -match "^(NEAR|TAKE_DONE|WARN|RECPEAK)") { Say ("  · {0}" -f $line) }
  }
}

try { $sp.Close() } catch {}
Say ""
Say "  桥已停止。"
