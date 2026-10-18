#!/usr/bin/env bash
set -u
cd /root/plugim

pkill -f 'tsx watch src/index.ts' 2>/dev/null
pkill -f 'vite' 2>/dev/null
sleep 2

T=/tmp/plugim-open-check
rm -rf "$T"
mkdir -p "$T"
printf '{"dbDriver":"sqlite","dbFile":"%s/p.db","logDir":"%s/log"}\n' "$T" "$T" > "$T/install.json"

PLUGIM_INSTALL_FILE=$T/install.json PORT=3000 pnpm --filter @plugim/server start > "$T/server.log" 2>&1 &
cd /root/plugim/apps/web && pnpm exec vite --port 5173 --strictPort > "$T/vite.log" 2>&1 &

for i in $(seq 1 60); do
  if curl -sf -m 2 http://127.0.0.1:3000/health > /dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "--- backend /open/whoami (direct) ---"
curl -s -o /dev/null -w '%{http_code}\n' -m 5 http://127.0.0.1:3000/open/whoami

echo "--- backend /open/whoami (no token) ---"
curl -s -m 5 http://127.0.0.1:3000/open/whoami | head -c 200
echo

echo "--- through vite :5173 ---"
for i in $(seq 1 40); do
  if curl -sf -m 2 http://127.0.0.1:5173/ > /dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -s -m 5 http://127.0.0.1:5173/open/whoami | head -c 200
echo

echo "--- SPA fallback must NOT swallow /open ---"
curl -s -o /dev/null -w 'content-type=%{content_type} code=%{http_code}\n' -m 5 http://127.0.0.1:5173/open/whoami
