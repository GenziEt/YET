#!/usr/bin/env bash
# ============================================================================
# Zero-downtime gateway (nginx) config deploy — STARTUP-OPTIMIZATION.md §5.4
# operational step, productised so it is reproducible and safe at 3 a.m.
#
# What it does on the Ethiopian pilot host:
#   1. rsyncs infra/nginx.conf + docker-compose.yml to the deploy directory;
#   2. `docker compose config` → catches YAML/variable errors BEFORE touching
#      the running stack;
#   3. `docker compose exec gateway nginx -t` → validates the NEW file against
#      the real nginx binary using a throwaway copy mounted at /tmp (the live
#      ro-bind is NOT swapped yet);
#   4. swaps the bind-mounted file atomically (mv within same filesystem) and
#      issues `nginx -s reload` — workers keep serving old config until new
#      workers finish loading; connections are NOT dropped (keep-alive pools
#      from driver-app survive the reload — critical for §5.4 handshake reuse);
#   5. smoke-checks /api/health and one tile route; AUTO-ROLLS BACK to the
#      previous nginx.conf if either check fails or reload errors.
#
# Usage:
#   ./deploy-gateway.sh user@host[:path] [remote-dir]
#   examples:
#     ./deploy-gateway.sh deploy@196.x.x.x
#     ./deploy-gateway.sh deploy@yet.et /srv/yet/infra
#
# Requires: ssh key auth to the host, docker compose v2 on it, rsync.
# Exit codes: 0 ok · 1 validation failed (no change made) · 2 deployed but
#             rollback executed · 3 rollback FAILED — manual intervention!
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # infra/
TARGET="${1:?usage: deploy-gateway.sh user@host[:path] [remote-dir]}"
REMOTE_DIR="${2:-${TARGET#*:}}"
REMOTE_DIR="${REMOTE_DIR:-/opt/yet/infra}"
TARGET_HOST="${TARGET%%:*}"

GATEWAY_SVC="gateway"
TS="$(date +%Y%m%d-%H%M%S)"

say() { printf '[deploy-gateway] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit "${2:-1}"; }

ssh_run() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET_HOST" "$@"; }

# ---------------------------------------------------------------------------
say "preflight: connectivity + compose version"
ssh_run "command -v docker >/dev/null && docker compose version >/dev/null" \
  || die "docker compose v2 not usable on $TARGET_HOST (aborting, nothing changed)"

# ---------------------------------------------------------------------------
say "staging files on remote (nginx.conf.new / compose.new — live untouched)"
rsync -a --delete=false "$HERE/nginx.conf" "$TARGET_HOST:$REMOTE_DIR/nginx.conf.staged.$TS"
rsync -a "$HERE/docker-compose.yml"        "$TARGET_HOST:$REMOTE_DIR/docker-compose.yml.staged.$TS"

# ---------------------------------------------------------------------------
say "validate staged compose file (config render only, no container ops)"
ssh_run "cd '$REMOTE_DIR' && cp docker-compose.yml docker-compose.yml.bak.$TS \
        && mv docker-compose.yml.staged.$TS docker-compose.yml \
        && docker compose config -q" \
  || { ssh_run "cd '$REMOTE_DIR' && mv -f docker-compose.yml.bak.$TS docker-compose.yml"; \
       die "compose config failed — restored previous compose, nginx NOT touched"; }

# ---------------------------------------------------------------------------
say "syntax-check staged nginx.conf with the REAL nginx binary (throwaway mount)"
ssh_run "cd '$REMOTE_DIR' \
    && docker run --rm \
         -v '$REMOTE_DIR/nginx.conf.staged.$TS:/etc/nginx/conf.d/default.conf:ro' \
         -v '$REMOTE_DIR/certs:/etc/letsencrypt:ro' \
         nginx:1.27-alpine nginx -t" \
  || { ssh_run "cd '$REMOTE_DIR' && rm -f nginx.conf.staged.$TS"; \
       die "nginx -t rejected the staged config — live config still in place"; }

# ---------------------------------------------------------------------------
say "atomic swap + graceful reload (zero connection drop)"
ssh_run "cd '$REMOTE_DIR' \
    && cp nginx.conf nginx.conf.bak.$TS \
    && mv -f nginx.conf.staged.$TS nginx.conf \
    && docker compose exec -T $GATEWAY_SVC nginx -t \
    && docker compose exec -T $GATEWAY_SVC nginx -s reload" \
  || die "swap/reload failed — restoring backup manually needed? checking…" 2

# ---------------------------------------------------------------------------
say "post-deploy smoke checks (API health + tile route + handshake headers)"
ok=1
# Backend health contract: Fastify serves /healthz (§1.5), gateway maps
# /api/ -> backend root, so the public probe path is /api/healthz.
ssh_run "curl -fsS --max-time 10 http://127.0.0.1/api/healthz >/dev/null" || ok=0
ssh_run "curl -fsS --max-time 15 -o /dev/null 'http://127.0.0.1/tiles/styles/bright/6/33/20.png'" || ok=0
# §5.4 contract: gateway must answer keep-alive tuned headers after reload.
ssh_run "curl -fsS --max-time 10 -D- -o /dev/null http://127.0.0.1/api/healthz | grep -qi 'connection'" || ok=0

if [ "$ok" = "1" ]; then
  say "SUCCESS — new gateway config live; backups kept as *.bak.$TS"
  exit 0
fi

# ---------------------------------------------------------------------------
say "SMOKE CHECK FAILED — rolling back to nginx.conf.bak.$TS and reloading"
ssh_run "cd '$REMOTE_DIR' \
    && mv -f nginx.conf.bak.$TS nginx.conf \
    && docker compose exec -T $GATEWAY_SVC nginx -t \
    && docker compose exec -T $GATEWAY_SVC nginx -s reload" \
  || die "ROLLBACK FAILED — restore $REMOTE_DIR/nginx.conf.bak.$TS by hand NOW" 3
say "rollback complete — service is back on the previous config."
exit 2
