#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this uninstaller with sudo.\n' >&2
  exit 1
fi

SERVICE_NAME="${HEALTHFLOW_SERVICE_NAME:-healthflow-branch}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SERVICE_FILE}"
systemctl daemon-reload

printf 'Removed %s systemd service. App files and SQLite data were preserved.\n' "${SERVICE_NAME}"
