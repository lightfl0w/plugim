#!/usr/bin/env bash
set -o pipefail
export PATH=/root/.local/share/pnpm/bin:$PATH
cd /root/plugim
pnpm dev:server 2>&1
