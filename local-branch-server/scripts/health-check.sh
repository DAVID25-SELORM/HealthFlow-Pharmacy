#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-4780}"
URL="${1:-http://127.0.0.1:${PORT}/health}"

if command -v curl >/dev/null 2>&1; then
  curl --fail --silent --show-error "$URL"
  printf '\n'
elif command -v wget >/dev/null 2>&1; then
  wget --quiet --output-document=- "$URL"
  printf '\n'
else
  printf 'Install curl or wget to run the HealthFlow health check.\n' >&2
  exit 1
fi
