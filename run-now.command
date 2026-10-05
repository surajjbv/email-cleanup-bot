#!/bin/zsh
# Double-click in Finder to run the bot once and open the dashboard.
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
B=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[1;31m'; GRN=$'\e[1;32m'; OFF=$'\e[0m'
echo "${B}email-cleanup-bot${OFF} · on-demand run\n"
[[ -f .env ]] || { echo "${RED}No .env file here. See README setup.${OFF}"; read -k1 -s; exit 1; }
START=$SECONDS
npm start --silent -- --open
CODE=$?
(( CODE == 0 )) && echo "\n${GRN}✔ Done in $(( SECONDS - START ))s.${OFF}" || echo "\n${RED}✘ Finished with problems after $(( SECONDS - START ))s.${OFF} See data/bot.log."
echo "${DIM}Press any key to close this window.${OFF}"; read -k1 -s; exit $CODE
