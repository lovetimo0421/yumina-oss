#!/bin/bash
# Yumina — set up a local model on this Mac.
#
# What this does, in order (nothing else):
#   1. Installs Ollama (Ollama-darwin.zip from ollama.com, checked to be signed
#      by Ollama) into Applications, unless it is already installed.
#   2. Allows __ORIGIN__ to talk to Ollama (OLLAMA_ORIGINS), including after
#      a restart, via ~/Library/LaunchAgents/io.yumina.ollama-origins.plist.
#   3. Restarts Ollama so that setting takes effect.
#   4. Downloads one model sized for this Mac's memory (ollama pull).
#
# It sends nothing to Yumina and never asks for your password.
# To undo: drag Ollama from Applications to the Trash, delete ~/.ollama, and
# delete ~/Library/LaunchAgents/io.yumina.ollama-origins.plist.

YUMINA_ORIGIN='__ORIGIN__'
YUMINA_LANG='__LANG__'
# setup = the whole thing; allow = only let this site connect and restart Ollama.
YUMINA_MODE='__MODE__'

yumina_setup() {
  set -euo pipefail

  say() { if [ "$YUMINA_LANG" = "zh" ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
  local total=4
  if [ "$YUMINA_MODE" = "allow" ]; then total=2; fi
  step() { printf '\n\033[36m[%s/%s] ' "$1" "$total"; say "$2" "$3"; printf '\033[0m'; }
  ok() { printf '\033[32m'; say "$1" "$2"; printf '\033[0m'; }
  warn() { printf '\033[33m'; say "$1" "$2"; printf '\033[0m'; }

  if [ "$(uname -s)" != "Darwin" ]; then
    say "这个脚本只适用于 Mac。Linux 请按 Yumina 里的手动步骤操作。" "This script is for macOS only. On Linux, follow the manual steps in Yumina."
    return 1
  fi

  if [ "$YUMINA_MODE" = "allow" ]; then
    printf '\n\033[35m'; say "== 让 Ollama 允许 Yumina 连接 ==" "== Let Ollama accept Yumina =="; printf '\033[0m'
    say "只做两件事：允许 $YUMINA_ORIGIN 连接 Ollama，然后重启 Ollama（不用重启电脑）。不会下载或安装任何东西。" \
        "Two things only: allow $YUMINA_ORIGIN to connect to Ollama, then restart Ollama (not your computer). Nothing is downloaded or installed."
  else
    printf '\n\033[35m'; say "== Yumina 本地模型一键安装 ==" "== Yumina local model setup =="; printf '\033[0m\n'
    say "接下来会做这 4 件事：" "This will do four things:"
    say "  1. 安装 Ollama（免费开源软件，Ollama Inc. 出品，从 ollama.com 官方下载，约 200 MB；已装过就跳过）" \
        "  1. Install Ollama (free, open-source, by Ollama Inc., from ollama.com, about 200 MB; skipped if already installed)"
    say "  2. 允许 $YUMINA_ORIGIN 连接 Ollama（重启电脑后也保持）" \
        "  2. Allow $YUMINA_ORIGIN to connect to Ollama (kept after a restart)"
    say "  3. 重启 Ollama，让设置生效" "  3. Restart Ollama so the setting takes effect"
    say "  4. 按你的内存下载一个 Qwen 模型（阿里巴巴通义千问，Apache 2.0 协议，3.4–17 GB）" \
        "  4. Download one Qwen model sized for your memory (by Alibaba, Apache 2.0, 3.4–17 GB)"
    echo
    warn "一共要下载：大多数人约 7 GB（最少约 4 GB，最多约 17 GB），已经有的部分会跳过。" "Total download: about 7 GB for most people (4 GB at least, 17 GB at most); anything you already have is skipped."
    say "不会上传任何东西给 Yumina，也不会要你的密码。" "Nothing is sent to Yumina and it never asks for your password."
    say "想撤销：把「应用程序」里的 Ollama 拖进废纸篓即可。" "To undo: drag Ollama from Applications to the Trash."
    echo
    local go=""
    if [ "$YUMINA_LANG" = "zh" ]; then printf '按回车开始，输入 n 取消：'; else printf 'Press Enter to start, or type n to cancel: '; fi
    # YUMINA_SETUP_YES=1 answers yes to every question (unattended runs, like Homebrew's NONINTERACTIVE).
    if [ "${YUMINA_SETUP_YES:-}" = "1" ]; then echo; else read -r go </dev/tty || true; fi
    case "$go" in n|N*) warn "已取消，什么都没改。" "Cancelled. Nothing was changed."; return 0 ;; esac
  fi

  # ── 1. Ollama ──
  if [ "$YUMINA_MODE" != "allow" ]; then step 1 "检查 Ollama" "Checking for Ollama"; fi
  local app=""
  for candidate in "/Applications/Ollama.app" "$HOME/Applications/Ollama.app"; do
    if [ -d "$candidate" ]; then app="$candidate"; break; fi
  done
  if [ -n "$app" ]; then
    if [ "$YUMINA_MODE" != "allow" ]; then ok "已经装好了，跳过。" "Already installed, skipping."; fi
  elif [ "$YUMINA_MODE" = "allow" ]; then
    say "这台电脑还没装 Ollama。请回到 Yumina，用「一键安装」那行命令。" "Ollama is not installed on this computer. Use the one-command install in Yumina instead."
    return 1
  else
    say "没找到，从 ollama.com 下载安装…" "Not found. Downloading from ollama.com..."
    local tmp; tmp="$(mktemp -d)"
    curl --fail --show-error --location --progress-bar -o "$tmp/Ollama-darwin.zip" "https://ollama.com/download/Ollama-darwin.zip"
    unzip -q "$tmp/Ollama-darwin.zip" -d "$tmp"
    # Refuse anything not signed by Ollama and accepted by Gatekeeper.
    if ! codesign --verify --deep --strict "$tmp/Ollama.app" 2>/dev/null \
      || ! codesign -dv --verbose=2 "$tmp/Ollama.app" 2>&1 | grep -q "Authority=Developer ID Application: Ollama" \
      || ! spctl --assess --type execute "$tmp/Ollama.app" 2>/dev/null; then
      rm -rf "$tmp"
      say "下载的安装包签名校验没通过，已停止。" "The download failed its signature check. Stopped."
      return 1
    fi
    if [ -w "/Applications" ]; then app="/Applications/Ollama.app"; else mkdir -p "$HOME/Applications"; app="$HOME/Applications/Ollama.app"; fi
    mv "$tmp/Ollama.app" "$app"
    rm -rf "$tmp"
    ok "Ollama 装好了。" "Ollama installed."
  fi
  local cli="$app/Contents/Resources/ollama"

  # ── 2. Allow the site (and keep it after a restart) ──
  step "$([ "$YUMINA_MODE" = "allow" ] && echo 1 || echo 2)" "允许 $YUMINA_ORIGIN 连接 Ollama" "Allowing $YUMINA_ORIGIN to connect to Ollama"
  local current origins
  current="$(launchctl getenv OLLAMA_ORIGINS 2>/dev/null || true)"
  case ",$current," in
    *",$YUMINA_ORIGIN,"*) origins="$current" ;;
    ",,") origins="$YUMINA_ORIGIN" ;;
    *) origins="$current,$YUMINA_ORIGIN" ;;
  esac
  launchctl setenv OLLAMA_ORIGINS "$origins"
  local agent="$HOME/Library/LaunchAgents/io.yumina.ollama-origins.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.yumina.ollama-origins</string>
  <key>ProgramArguments</key>
  <array><string>/bin/launchctl</string><string>setenv</string><string>OLLAMA_ORIGINS</string><string>$origins</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST
  ok "已允许（重启电脑后也保持）。" "Allowed (kept after a restart)."

  # ── 3. Restart Ollama ──
  step "$([ "$YUMINA_MODE" = "allow" ] && echo 2 || echo 3)" "重启 Ollama，让设置生效（不用重启电脑）" "Restarting Ollama so the setting takes effect (not your computer)"
  osascript -e 'tell application "Ollama" to quit' >/dev/null 2>&1 || true
  pkill -x Ollama >/dev/null 2>&1 || true
  pkill -x ollama >/dev/null 2>&1 || true
  sleep 2
  open -a "$app" --args hidden
  local i=0
  until curl -fsS -o /dev/null http://127.0.0.1:11434/api/version; do
    i=$((i + 1)); if [ "$i" -ge 60 ]; then say "Ollama 60 秒内没有启动。" "Ollama did not start within 60 seconds."; return 1; fi
    sleep 1
  done
  if ! curl -fsS -o /dev/null -D - -H "Origin: $YUMINA_ORIGIN" http://127.0.0.1:11434/api/version | tr -d '\r' | grep -qi "^access-control-allow-origin: $YUMINA_ORIGIN\$"; then
    say "Ollama 启动了，但还是不接受 $YUMINA_ORIGIN。" "Ollama is running but still refuses $YUMINA_ORIGIN."
    return 1
  fi
  ok "Ollama 已启动，并且允许 Yumina 连接。" "Ollama is running and accepts Yumina."

  if [ "$YUMINA_MODE" = "allow" ]; then
    echo
    ok "== 好了 ==" "== Done =="
    ok "回到 Yumina 网页，它会自动连上。这个窗口可以关掉了。" "Go back to Yumina; it connects on its own. You can close this window."
    return 0
  fi

  # ── 4. Model ──
  step 4 "下载模型" "Downloading a model"
  local mem_gb model size
  mem_gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if [ "$(uname -m)" != "arm64" ]; then
    warn "这台 Mac 不是 M 系列芯片，模型会跑得很慢。" "This Mac does not have an Apple silicon chip, so replies will be slow."
  fi
  if [ "$mem_gb" -ge 32 ]; then model="qwen3.8:27b"; size="17 GB"
  elif [ "$mem_gb" -ge 16 ]; then model="qwen3.5:9b"; size="6.6 GB"
  else
    model="qwen3.5:4b"; size="3.4 GB"
    if [ "$mem_gb" -lt 8 ]; then
      warn "内存只有约 ${mem_gb} GB，偏小，模型会跑得很慢。" "Only about ${mem_gb} GB of memory, which is low. Replies will be slow."
      local more=""
      if [ "$YUMINA_LANG" = "zh" ]; then printf '还要继续下载吗？(y/n) '; else printf 'Download anyway? (y/n) '; fi
      if [ "${YUMINA_SETUP_YES:-}" = "1" ]; then more=y; echo; else read -r more </dev/tty || true; fi
      case "$more" in y|Y*) ;; *) warn "好的，先停在这里。Ollama 已经装好。" "OK, stopping here. Ollama is installed."; return 0 ;; esac
    fi
  fi
  say "内存约 ${mem_gb} GB，选择 $model（$size）。" "About ${mem_gb} GB of memory. Choosing $model ($size)."
  local existing
  existing=$("$cli" list 2>/dev/null | tail -n +2 | grep -c . || true)
  if ! "$cli" list 2>/dev/null | grep -qF "$model" && [ "${existing:-0}" -gt 0 ]; then
    # They already have models; don't pull gigabytes they didn't ask for.
    ok "你已经有 ${existing} 个模型了，跳过下载。想用推荐的 $model，以后可以运行：ollama pull $model" \
       "You already have ${existing} models, so nothing is downloaded. For the recommended $model, run: ollama pull $model"
  elif "$cli" list 2>/dev/null | grep -qF "$model"; then
    ok "这个模型已经下载过了，跳过。" "This model is already downloaded, skipping."
  else
    say "开始下载，只需下载一次。下面会显示进度。" "Downloading. You only do this once; progress is shown below."
    "$cli" pull "$model"
  fi

  echo
  ok "== 全部完成 ==" "== All done =="
  ok "回到 Yumina 网页：浏览器问能不能访问本地网络时点「允许」，然后点「打开」。这个窗口可以关掉了。" \
     "Go back to Yumina: when the browser asks about your local network, choose Allow, then click \"Turn on\". You can close this window."
}

( yumina_setup )
yumina_status=$?
if [ "$yumina_status" -ne 0 ]; then
  echo
  if [ "$YUMINA_LANG" = "zh" ]; then
    printf '\033[31m安装没有完成。\033[0m 可以再运行一次这行命令重试；或者回到 Yumina，按「第一次用？4 步设置好」里的步骤手动操作。\n'
  else
    printf '\033[31mSetup did not finish.\033[0m Run the command again to retry, or follow the step-by-step guide in Yumina.\n'
  fi
fi
