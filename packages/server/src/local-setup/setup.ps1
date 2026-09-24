# Yumina — set up a local model on this Windows PC.
#
# What this does, in order (nothing else):
#   1. Installs Ollama with Ollama's own official installer (ollama.com/install.ps1),
#      unless Ollama is already installed.
#   2. Allows __ORIGIN__ to talk to Ollama (adds it to the OLLAMA_ORIGINS
#      user environment variable, keeping anything already there).
#   3. Restarts Ollama so that setting takes effect.
#   4. Downloads one model sized for your graphics card (ollama pull).
#
# It sends nothing to Yumina and needs no administrator rights.
# To undo: uninstall Ollama from Settings > Apps, and delete the
# OLLAMA_ORIGINS user environment variable.

$YuminaOrigin = '__ORIGIN__'
$YuminaLang = '__LANG__'
# 'setup' = the whole thing; 'allow' = only let this site connect and restart
# Ollama (for a player whose Ollama is installed but refuses the site).
$YuminaMode = '__MODE__'

function Yumina-Setup {
  $ErrorActionPreference = 'Stop'
  $zh = $YuminaLang -eq 'zh'

  function Say([string]$cn, [string]$en, [string]$color = 'Gray') {
    Write-Host $(if ($zh) { $cn } else { $en }) -ForegroundColor $color
  }
  $allowOnly = $YuminaMode -eq 'allow'
  $total = if ($allowOnly) { 2 } else { 4 }
  function Step([int]$n, [string]$cn, [string]$en) {
    Write-Host ''
    Say "[$n/$total] $cn" "[$n/$total] $en" 'Cyan'
  }

  if ($allowOnly) {
    Write-Host ''
    Say '== 让 Ollama 允许 Yumina 连接 ==' '== Let Ollama accept Yumina ==' 'Magenta'
    Say "只做两件事：允许 $YuminaOrigin 连接 Ollama，然后重启 Ollama（不用重启电脑）。不会下载或安装任何东西。" `
        "Two things only: allow $YuminaOrigin to connect to Ollama, then restart Ollama (not your computer). Nothing is downloaded or installed."
  } else {
    Write-Host ''
    Say '== Yumina 本地模型一键安装 ==' '== Yumina local model setup ==' 'Magenta'
    Write-Host ''
    Say '接下来会做这 4 件事：' 'This will do four things:'
    Say '  1. 安装 Ollama（免费开源软件，Ollama Inc. 出品，从 ollama.com 官方下载，约 1.5 GB；已装过就跳过）' `
        '  1. Install Ollama (free, open-source, by Ollama Inc., from ollama.com, about 1.5 GB; skipped if already installed)'
    Say "  2. 允许 $YuminaOrigin 连接 Ollama（在你的用户环境变量 OLLAMA_ORIGINS 里加上这个网址）" `
        "  2. Allow $YuminaOrigin to connect to Ollama (adds it to your OLLAMA_ORIGINS user environment variable)"
    Say '  3. 重启 Ollama，让设置生效' '  3. Restart Ollama so the setting takes effect'
    Say '  4. 按你的显卡下载一个 Qwen 模型（阿里巴巴通义千问，Apache 2.0 协议，3.4–17 GB）' `
        '  4. Download one Qwen model sized for your graphics card (by Alibaba, Apache 2.0, 3.4–17 GB)'
    Write-Host ''
    Say '一共要下载：大多数人约 8 GB（最少约 5 GB，最多约 19 GB），已经有的部分会跳过。' `
        'Total download: about 8 GB for most people (5 GB at least, 19 GB at most); anything you already have is skipped.' 'Yellow'
    Say '不会上传任何东西给 Yumina，也不需要管理员权限。' 'Nothing is sent to Yumina and no admin rights are needed.'
    Say '想撤销：在「设置 → 应用」里卸载 Ollama 即可。' 'To undo: uninstall Ollama from Settings > Apps.'
    Write-Host ''
    # YUMINA_SETUP_YES=1 answers yes to every question (unattended runs, like Homebrew's NONINTERACTIVE).
    $unattended = $env:YUMINA_SETUP_YES -eq '1'
    $go = if ($unattended) { '' } else { Read-Host $(if ($zh) { '按回车开始，输入 n 取消' } else { 'Press Enter to start, or type n to cancel' }) }
    if ($go -match '^[nN]') { Say '已取消，什么都没改。' 'Cancelled. Nothing was changed.' 'Yellow'; return }
  }

  $free = (Get-PSDrive -Name ($env:LOCALAPPDATA.Substring(0, 1)) -ErrorAction SilentlyContinue).Free
  if (-not $allowOnly -and $free -and $free -lt 25GB) {
    Say "提示：$($env:LOCALAPPDATA.Substring(0, 1)) 盘只剩约 $([math]::Round($free / 1GB)) GB，可能不够放 Ollama 和模型。" `
        "Note: only about $([math]::Round($free / 1GB)) GB free on drive $($env:LOCALAPPDATA.Substring(0, 1)); Ollama plus a model may not fit." 'Yellow'
  }

  # ── 1. Ollama ──────────────────────────────────────────────────────────
  if (-not $allowOnly) { Step 1 '检查 Ollama' 'Checking for Ollama' }
  $dir = Join-Path $env:LOCALAPPDATA 'Programs\Ollama'
  $exe = Join-Path $dir 'ollama.exe'
  if (-not (Test-Path $exe)) {
    $found = Get-Command ollama -ErrorAction SilentlyContinue
    if ($found) { $exe = $found.Source; $dir = Split-Path $exe }
  }
  if (Test-Path $exe) {
    if (-not $allowOnly) { Say '已经装好了，跳过。' 'Already installed, skipping.' 'Green' }
  } elseif ($allowOnly) {
    throw $(if ($zh) { '这台电脑还没装 Ollama。请回到 Yumina，用「一键安装」那行命令。' } else { 'Ollama is not installed on this computer. Use the one-command install in Yumina instead.' })
  } else {
    Say '没找到，开始用 Ollama 官方安装程序安装（约 1.5 GB，网速慢的话要等一会儿）…' `
        'Not found. Installing with the official Ollama installer (about 1.5 GB, this can take a while)...'
    # Ollama's own script: downloads OllamaSetup.exe, checks it is signed by
    # Ollama Inc., installs silently. Run in its own scope so its variables
    # stay out of ours.
    & { Invoke-RestMethod 'https://ollama.com/install.ps1' | Invoke-Expression }
    if (-not (Test-Path $exe)) {
      $found = Get-Command ollama -ErrorAction SilentlyContinue
      if ($found) { $exe = $found.Source; $dir = Split-Path $exe }
    }
    if (-not (Test-Path $exe)) { throw 'Ollama was installed but ollama.exe was not found.' }
    Say 'Ollama 装好了。' 'Ollama installed.' 'Green'
  }

  # ── 2. Allow the site ──────────────────────────────────────────────────
  Step $(if ($allowOnly) { 1 } else { 2 }) "允许 $YuminaOrigin 连接 Ollama" "Allowing $YuminaOrigin to connect to Ollama"
  $current = [Environment]::GetEnvironmentVariable('OLLAMA_ORIGINS', 'User')
  $origins = @()
  if ($current) { $origins = $current -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
  if ($origins -contains $YuminaOrigin) {
    Say '已经允许过了，跳过。' 'Already allowed, skipping.' 'Green'
  } else {
    $origins += $YuminaOrigin
    [Environment]::SetEnvironmentVariable('OLLAMA_ORIGINS', ($origins -join ','), 'User')
    Say '已允许。' 'Allowed.' 'Green'
  }
  # Ollama started from this window inherits this window's environment.
  $env:OLLAMA_ORIGINS = ($origins -join ',')

  # ── 3. Restart Ollama ──────────────────────────────────────────────────
  Step $(if ($allowOnly) { 2 } else { 3 }) '重启 Ollama，让设置生效（不用重启电脑）' 'Restarting Ollama so the setting takes effect (not your computer)'
  Get-Process -Name 'ollama app', 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  $app = Join-Path $dir 'ollama app.exe'
  if (Test-Path $app) { Start-Process -FilePath $app -WindowStyle Hidden }
  else { Start-Process -FilePath $exe -ArgumentList 'serve' -WindowStyle Hidden }
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
      $ready = $true
    } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { throw 'Ollama did not start within 60 seconds.' }
  # Ask the way the browser will: Ollama answers 403 to an origin it refuses.
  $allowed = $false
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:11434/api/version' -Headers @{ Origin = $YuminaOrigin } -TimeoutSec 5
    $allowed = (@($r.Headers['Access-Control-Allow-Origin']) -contains $YuminaOrigin)
  } catch { $allowed = $false }
  if (-not $allowed) { throw "Ollama is running but still refuses $YuminaOrigin." }
  Say 'Ollama 已启动，并且允许 Yumina 连接。' 'Ollama is running and accepts Yumina.' 'Green'

  if ($allowOnly) {
    Write-Host ''
    Say '== 好了 ==' '== Done ==' 'Green'
    Say '回到 Yumina 网页，它会自动连上。这个窗口可以关掉了。' 'Go back to Yumina; it connects on its own. You can close this window.' 'Green'
    return
  }

  # ── 4. Model ───────────────────────────────────────────────────────────
  Step 4 '下载模型' 'Downloading a model'
  $vram = 0
  $class = 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}'
  Get-ChildItem $class -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
    $v = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize'
    if ($v -is [array]) { $v = $v[0] }
    if ($v -and [double]$v -gt $vram) { $vram = [double]$v }
  }
  $vramGb = [math]::Round($vram / 1GB)
  if ($vramGb -ge 22) {
    $model = 'qwen3.8:27b'; $size = '17 GB'
  } elseif ($vramGb -ge 7) {
    $model = 'qwen3.5:9b'; $size = '6.6 GB'
  } elseif ($vramGb -ge 5) {
    $model = 'qwen3.5:4b'; $size = '3.4 GB'
  } else {
    $model = 'qwen3.5:4b'; $size = '3.4 GB'
    if ($vramGb -gt 0) {
      Say "你的显卡显存约 $vramGb GB，偏小，模型会跑得很慢。" "Your graphics card has about $vramGb GB of VRAM, which is low. Replies will be slow." 'Yellow'
    } else {
      Say '没有检测到独立显卡，模型会跑得很慢。' 'No dedicated graphics card found. Replies will be slow.' 'Yellow'
    }
    $answer = if ($unattended) { 'y' } else { Read-Host $(if ($zh) { '还要继续下载吗？(y/n)' } else { 'Download anyway? (y/n)' }) }
    if ($answer -notmatch '^[yY]') {
      Say '好的，先停在这里。Ollama 已经装好，以后想用可以再运行一次。' 'OK, stopping here. Ollama is installed; run this again any time.' 'Yellow'
      return
    }
  }
  if ($vramGb -gt 0) {
    Say "检测到显存约 $vramGb GB，选择 $model（$size）。" "Found about $vramGb GB of VRAM. Choosing $model ($size)."
  }
  $existing = @(& $exe list 2>$null | Select-Object -Skip 1 | Where-Object { $_.Trim() })
  $have = $existing | Select-String -SimpleMatch $model
  if (-not $have -and $existing.Count -gt 0) {
    # They already have models; don't pull gigabytes they didn't ask for.
    Say "你已经有 $($existing.Count) 个模型了，跳过下载。想用推荐的 $model，以后可以运行：ollama pull $model" `
        "You already have $($existing.Count) models, so nothing is downloaded. For the recommended $model, run: ollama pull $model" 'Green'
  } elseif ($have) {
    Say '这个模型已经下载过了，跳过。' 'This model is already downloaded, skipping.' 'Green'
  } else {
    Say '开始下载，只需下载一次。下面会显示进度。' 'Downloading. You only do this once; progress is shown below.'
    & $exe pull $model
    if ($LASTEXITCODE -ne 0) { throw "Downloading $model failed." }
  }

  Write-Host ''
  Say '== 全部完成 ==' '== All done ==' 'Green'
  Say '回到 Yumina 网页：浏览器问能不能访问本地网络时点「允许」，然后点「打开」。这个窗口可以关掉了。' `
      'Go back to Yumina: when the browser asks about your local network, choose Allow, then click "Turn on". You can close this window.' 'Green'
}

try {
  Yumina-Setup
} catch {
  Write-Host ''
  if ($YuminaLang -eq 'zh') {
    Write-Host "安装没有完成：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host '可以再运行一次这行命令重试；或者回到 Yumina，按「第一次用？4 步设置好」里的步骤手动操作。' -ForegroundColor Yellow
  } else {
    Write-Host "Setup did not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Run the command again to retry, or follow the step-by-step guide in Yumina.' -ForegroundColor Yellow
  }
}
