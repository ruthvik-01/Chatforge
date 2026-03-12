#!/bin/bash
# Usage: TOKEN=<new_whatsapp_api_token> ./update_token.sh
# Or edit the TOKEN variable below before running.
TOKEN="${TOKEN:-YOUR_WHATSAPP_API_TOKEN_HERE}"
sed -i "s|WHATSAPP_API_TOKEN=.*|WHATSAPP_API_TOKEN=${TOKEN}|" "$HOME/ChatForge/.env"
pm2 restart chatforge --update-env
sleep 2
pm2 logs chatforge --lines 4 --nostream
