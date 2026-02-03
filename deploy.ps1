# Deploy Alias: backend (Worker) + frontend (commit all + push to GitHub -> Cloudflare Pages)
# Run from repo root: .\deploy.ps1

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
if (-not $root) { $root = Get-Location }

Write-Host "=== Deploy backend (Worker) ===" -ForegroundColor Cyan
Push-Location (Join-Path $root "worker")
try {
    npm run deploy
    if ($LASTEXITCODE -ne 0) { throw "wrangler deploy failed" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "=== Commit all and push (GitHub -> Cloudflare Pages) ===" -ForegroundColor Cyan
Push-Location $root
try {
    $status = git status --porcelain
    if ($status) {
        git add -A
        $msg = "deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
        git commit -m $msg
        if ($LASTEXITCODE -ne 0) { throw "git commit failed" }
    }
    git push
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Done. Backend deployed, frontend will update after Cloudflare Pages build." -ForegroundColor Green
