#!/usr/bin/env bash
# Deploy Alias: backend (Worker) + frontend (commit all + push -> Cloudflare Pages)
# Run from repo root: ./deploy.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "=== Деплой бэкенда (Worker) ==="
(cd "$ROOT/worker" && npm run deploy)

echo ""
echo "=== Commit all and push (GitHub -> Cloudflare Pages) ==="
(cd "$ROOT" && {
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -m "deploy: $(date '+%Y-%m-%d %H:%M')"
  fi
  git push
})

echo ""
echo "Done. Backend deployed, frontend will update after Cloudflare Pages build."
