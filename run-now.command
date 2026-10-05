#!/bin/zsh
# Double-click in Finder to run the bot once and open the dashboard.
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
B=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[1;31m'; GRN=$'\e[1;32m'; YEL=$'\e[1;33m'; OFF=$'\e[0m'
say_done() { echo; echo "${DIM}Press any key to close this window.${OFF}"; read -k1 -s; exit ${1:-0}; }

echo "${B}email-cleanup-bot${OFF} · on-demand run\n"
[[ -f .env ]] || { echo "${RED}No .env file here. See README setup.${OFF}"; say_done 1; }
mkdir -p data/state
find data/state -maxdepth 1 -name lock -mmin +60 -exec rmdir {} \; 2>/dev/null
mkdir data/state/lock 2>/dev/null || { echo "${YEL}Another run is in progress. Try again in a few minutes.${OFF}"; say_done 1; }
trap 'rmdir data/state/lock 2>/dev/null; ~/.lmstudio/bin/lms unload email-cleanup-bot >/dev/null 2>&1' EXIT

START=$SECONDS
node bot.js --open
CODE=$?
(( CODE == 0 )) && echo "\n${GRN}✔ Done in $(( SECONDS - START ))s.${OFF}" || echo "\n${RED}✘ Finished with problems after $(( SECONDS - START ))s.${OFF} See data/bot.log."
say_done $CODE
