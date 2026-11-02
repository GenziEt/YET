#!/usr/bin/env bash
# ============================================================================
# Audit P0 (TLS): Let's Encrypt certificate issuance + renewal for the YET
# production gateway. Closes the "no demonstrated certificate renewal
# workflow" blocker from the production-readiness audit.
#
# Model: nginx (the `gateway` service) owns port 80/443; certbot runs as a
# companion container (`certbot` in docker-compose.yml) that renews every
# 12h via http-01 against the shared webroot ./certs/www. Key material lives
# in ./certs on the HOST, bind-mounted read-only into the gateway at
# /etc/letsencrypt — keys never leave the Ethiopian production host.
#
# Usage (run FROM the infra/ directory on the pilot host):
#   ./scripts/tls-certbot.sh issue admin@yourco.et api.yourco.et [staging]
#   ./scripts/tls-certbot.sh renew
#   ./scripts/tls-certbot.sh status
#
# After a successful `issue`:
#   1. put YET_DOMAIN=<domain> and YET_TLS_ENFORCE=1 into .env
#   2. run ./scripts/deploy-gateway.sh <user@host> — it renders the 443
#      server block only when certs exist, validates with nginx -t, swaps
#      atomically, and auto-rolls back if smoke checks fail.
# Exit codes: 0 ok · 1 usage/validation failure · 2 certbot failed
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # infra/
cd "$HERE"

say() { printf '[tls-certbot] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit "${2:-1}"; }

compose() { docker compose "$@"; }

ensure_dirs() {
  mkdir -p certs/www
  chmod 700 certs 2>/dev/null || true
}

reload_gateway() {
  # Certificates are live-swapped under the same path; nginx just needs to
  # re-read them. Graceful reload keeps driver-app keep-alive pools alive.
  compose exec -T gateway nginx -t \
    && compose exec -T gateway nginx -s reload \
    && say "gateway reloaded (new/updated certificates live)" \
    || die "nginx rejected config after cert change — check ./certs" 2
}

case "${1:?usage: tls-certbot.sh issue|renew|status ...}" in
  issue)
    EMAIL="${2:?usage: tls-certbot.sh issue <email> <domain> [staging]}"
    DOMAIN="${3:?usage: tls-certbot.sh issue <email> <domain> [staging]}"
    STAGING=""
    [ "${4:-}" = "staging" ] && STAGING="--staging"
    ensure_dirs
    say "requesting certificate for $DOMAIN via http-01 (webroot ./certs/www)"
    # The gateway must already serve /.well-known/acme-challenge/ from the
    # webroot (nginx.conf ships that location). Run BEFORE enabling TLS
    # enforcement so the challenge is reachable over plain HTTP.
    compose up -d gateway
    # shellcheck disable=SC2086
    if ! compose run --rm certbot certonly --webroot -w /var/www/certbot \
        -m "$EMAIL" --agree-tos --no-eff-email $STAGING -d "$DOMAIN"; then
      die "certbot issuance FAILED — TLS enforcement must stay off (YET_TLS_ENFORCE unset/0)" 2
    fi
    say "certificate issued under ./certs/live/$DOMAIN"
    say "next: set YET_DOMAIN=$DOMAIN and YET_TLS_ENFORCE=1 in .env, then deploy-gateway.sh"
    ;;

  renew)
    ensure_dirs
    say "checking renewals (certbot skips unless <30 days remain)"
    if compose run --rm certbot renew --webroot -w /var/www/certbot; then
      reload_gateway
    else
      die "certbot renew FAILED — investigate before expiry!" 2
    fi
    ;;

  status)
    compose run --rm certbot certificates
    ;;

  *)
    die "unknown subcommand '${1}' (expected issue|renew|status)" 1
    ;;
esac
