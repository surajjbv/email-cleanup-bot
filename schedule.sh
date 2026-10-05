#!/bin/bash
# bash schedule.sh install    install the launchd agent (checks every 15 min)
# bash schedule.sh uninstall  remove it
# bash schedule.sh            (called by launchd) run once a day after run_time (config.json), at least 10 min after
#                             boot/wake. A failed run is retried every 30 min until it succeeds that day.
set -u
cd "$(dirname "$0")"
LABEL=com.email-cleanup-bot
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
install)
  mkdir -p data "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PWD/schedule.sh</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PWD/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$PWD/data/launchd.log</string>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Scheduled daily at run_time (config.json). Remove with: bash schedule.sh uninstall"
  exit ;;
uninstall)
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Unscheduled."
  exit ;;
esac

mkdir -p data/state
run_time=$(node -e 'let t="";try{t=String(require("./config.json").run_time??"")}catch(e){}const m=t.trim().match(/^(\d{1,2}):([0-5]\d)$/);if(m&&+m[1]<24)t=String(+m[1]).padStart(2,"0")+":"+m[2];console.log(t||"07:00")' 2>/dev/null)
run_time=${run_time:-07:00}
[[ "$(date +%H:%M)" < "$run_time" ]] && exit 0
secs() { sysctl -n "$1" | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime)
(( $(date +%s) - (wake > boot ? wake : boot) < 600 )) && exit 0

key="data/state/$(date +%F)"
[ -e "$key.done" ] && exit 0
[ -n "$(find "$key.tried" -mmin -30 2>/dev/null)" ] && exit 0   # failed less than 30 min ago
find data/state -maxdepth 1 -name lock -mmin +60 -exec rmdir {} \; 2>/dev/null  # left by a crash or power loss
mkdir data/state/lock 2>/dev/null || exit 0
trap 'rmdir data/state/lock; "$HOME/.lmstudio/bin/lms" unload email-cleanup-bot >/dev/null 2>&1' EXIT
touch "$key.tried"

node bot.js >> data/run.out 2>&1 && touch "$key.done"
find data/state -name '20*' -mtime +7 -delete 2>/dev/null
