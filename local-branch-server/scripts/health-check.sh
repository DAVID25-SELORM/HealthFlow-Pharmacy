#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4780}"
URL="${1:-http://127.0.0.1:${PORT}/health}"
BRANCH_TOKEN="${BRANCH_SERVER_TOKEN:-}"
CURL_HEADERS=()
WGET_HEADERS=()

if [ -z "$BRANCH_TOKEN" ] && [ -f ".env" ]; then
  BRANCH_TOKEN="$(sed -n 's/^BRANCH_SERVER_TOKEN=//p' .env | head -n 1)"
fi

if [ -z "$BRANCH_TOKEN" ]; then
  printf 'Set BRANCH_SERVER_TOKEN or run this script from the local-branch-server directory with .env present.\n' >&2
  exit 1
fi

CURL_HEADERS=(-H "x-branch-token: ${BRANCH_TOKEN}")
WGET_HEADERS=(--header "x-branch-token: ${BRANCH_TOKEN}")

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error "${CURL_HEADERS[@]}" "$URL"
  printf '\n'
elif command -v wget >/dev/null 2>&1; then
  wget --quiet "${WGET_HEADERS[@]}" --output-document=- "$URL"
  printf '\n'
else
  printf 'Install curl or wget to run the HealthFlow health check.\n' >&2
  exit 1
fi
