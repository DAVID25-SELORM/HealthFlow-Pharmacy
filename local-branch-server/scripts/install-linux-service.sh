#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this installer with sudo.\n' >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${HEALTHFLOW_INSTALL_DIR:-/opt/healthflow/local-branch-server}"
SERVICE_USER="${HEALTHFLOW_SERVICE_USER:-healthflow}"
DATA_DIR="${HEALTHFLOW_DATA_DIR:-/var/lib/healthflow-branch}"
SERVICE_NAME="${HEALTHFLOW_SERVICE_NAME:-healthflow-branch}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
UPDATER_DIR="/usr/local/lib/healthflow"
UPDATER_PATH="${UPDATER_DIR}/apply-update-linux.sh"
UPDATER_CONFIG="/etc/healthflow-branch-updater.conf"
SUDOERS_FILE="/etc/sudoers.d/healthflow-branch-updater"
LOG_DIR="${HEALTHFLOW_LOG_DIR:-/var/log/healthflow-branch}"
WAS_ACTIVE=false

if [[ ! "${SERVICE_USER}" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  printf 'Invalid HEALTHFLOW_SERVICE_USER: %s\n' "${SERVICE_USER}" >&2
  exit 1
fi
if [[ ! "${SERVICE_NAME}" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
  printf 'Invalid HEALTHFLOW_SERVICE_NAME: %s\n' "${SERVICE_NAME}" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 20+ is required. Install Node first, then rerun this installer.\n' >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  printf 'Node.js 20+ is required. Current version: %s\n' "$(node -v)" >&2
  exit 1
fi

for command_name in curl npm sudo systemctl unzip visudo; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    printf '%s is required for the HealthFlow Linux service and signed updater.\n' "${command_name}" >&2
    exit 1
  fi
done

if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
  WAS_ACTIVE=true
  systemctl stop "${SERVICE_NAME}"
fi

restore_service_on_failure() {
  local exit_code=$?
  if [[ "${exit_code}" -ne 0 && "${WAS_ACTIVE}" == "true" ]]; then
    systemctl start "${SERVICE_NAME}" 2>/dev/null || true
  fi
  exit "${exit_code}"
}
trap restore_service_on_failure EXIT

if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
  NOLOGIN_SHELL="$(command -v nologin || printf '/usr/sbin/nologin')"
  useradd --system --home-dir "${INSTALL_DIR}" --shell "${NOLOGIN_SHELL}" "${SERVICE_USER}"
fi

mkdir -p "${INSTALL_DIR}" "${DATA_DIR}" "${LOG_DIR}" "${UPDATER_DIR}"

rsync_args=(-a --delete --exclude node_modules --exclude data --exclude .env)
if command -v rsync >/dev/null 2>&1; then
  rsync "${rsync_args[@]}" "${SOURCE_DIR}/" "${INSTALL_DIR}/"
else
  cp -a "${SOURCE_DIR}/." "${INSTALL_DIR}/"
  rm -rf "${INSTALL_DIR}/node_modules" "${INSTALL_DIR}/data"
fi

if [[ ! -f "${INSTALL_DIR}/.env" ]]; then
  if [[ -f "${SOURCE_DIR}/.env" ]]; then
    cp "${SOURCE_DIR}/.env" "${INSTALL_DIR}/.env"
  else
    cp "${INSTALL_DIR}/.env.linux.example" "${INSTALL_DIR}/.env"
    printf 'Created %s from .env.linux.example. Edit it before starting the service.\n' "${INSTALL_DIR}/.env"
  fi
fi

cd "${INSTALL_DIR}"
npm ci --omit=dev
npm run rebuild:sqlite

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}" "${DATA_DIR}"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${LOG_DIR}"

install -o root -g root -m 0755 \
  "${SOURCE_DIR}/scripts/apply-update-linux.sh" \
  "${UPDATER_PATH}"

{
  printf 'INSTALL_DIR=%q\n' "${INSTALL_DIR}"
  printf 'SERVICE_NAME=%q\n' "${SERVICE_NAME}"
  printf 'SERVICE_USER=%q\n' "${SERVICE_USER}"
  printf 'DATA_DIR=%q\n' "${DATA_DIR}"
  printf 'LOG_DIR=%q\n' "${LOG_DIR}"
} > "${UPDATER_CONFIG}"
chown root:root "${UPDATER_CONFIG}"
chmod 0600 "${UPDATER_CONFIG}"

cat > "${SUDOERS_FILE}" <<SUDOERS
${SERVICE_USER} ALL=(root) NOPASSWD: ${UPDATER_PATH} *
SUDOERS
chown root:root "${SUDOERS_FILE}"
chmod 0440 "${SUDOERS_FILE}"
visudo -cf "${SUDOERS_FILE}" >/dev/null

cat > "${SERVICE_FILE}" <<SERVICE
[Unit]
Description=HealthFlow Local Branch Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
ExecStart=$(command -v node) src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
if [[ "${WAS_ACTIVE}" == "true" ]]; then
  systemctl start "${SERVICE_NAME}"
fi
trap - EXIT

printf 'Installed %s.\n' "${SERVICE_NAME}"
printf 'Installed signed update helper: %s\n' "${UPDATER_PATH}"
printf 'Edit %s/.env, then start with: sudo systemctl start %s\n' "${INSTALL_DIR}" "${SERVICE_NAME}"
printf 'Check status with: sudo systemctl status %s\n' "${SERVICE_NAME}"
