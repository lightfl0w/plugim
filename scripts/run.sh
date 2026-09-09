#!/usr/bin/env bash
set -o pipefail
export PATH=/root/.local/share/pnpm/bin:$PATH
cd /root/plugim
pnpm --filter @plugim/web build 2>&1 | tail -8
