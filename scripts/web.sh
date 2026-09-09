#!/usr/bin/env bash
set -o pipefail
export PATH=/root/.local/share/pnpm/bin:$PATH
cd /root/plugim
pnpm dev:web 2>&1
