#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this uninstaller with sudo.\n' >&2
  exit 1
fi

SERVICE_NAME="${HEALTHFLOW_SERVICE_NAME:-healthflow-branch}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
UPDATER_PATH="/usr/local/lib/healthflow/apply-update-linux.sh"
UPDATER_CONFIG="/etc/healthflow-branch-updater.conf"
SUDOERS_FILE="/etc/sudoers.d/healthflow-branch-updater"

systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "${SERVICE_FILE}"
rm -f "${UPDATER_PATH}" "${UPDATER_CONFIG}" "${SUDOERS_FILE}"
systemctl daemon-reload

printf 'Removed %s systemd service. App files and SQLite data were preserved.\n' "${SERVICE_NAME}"
