#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'The HealthFlow Linux updater must run as root.\n' >&2
  exit 1
fi

CONFIG_FILE="/etc/healthflow-branch-updater.conf"
if [[ ! -f "${CONFIG_FILE}" ]]; then
  printf 'Linux updater configuration not found: %s\n' "${CONFIG_FILE}" >&2
  exit 1
fi

# This file is created by install-linux-service.sh and is root-owned.
# shellcheck source=/dev/null
source "${CONFIG_FILE}"

PACKAGE_PATH="${1:-}"
EXPECTED_VERSION="${2:-}"
if [[ -z "${PACKAGE_PATH}" || -z "${EXPECTED_VERSION}" ]]; then
  printf 'Usage: apply-update-linux.sh <package-path> <expected-version>\n' >&2
  exit 1
fi

if [[ ! "${EXPECTED_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][A-Za-z0-9.-]+)?$ ]]; then
  printf 'Invalid expected version: %s\n' "${EXPECTED_VERSION}" >&2
  exit 1
fi

INSTALL_DIR="$(readlink -f "${INSTALL_DIR}")"
UPDATES_DIR="${INSTALL_DIR}/updates"
PACKAGE_PATH="$(readlink -f "${PACKAGE_PATH}")"
EXPECTED_PACKAGE_PATH="${UPDATES_DIR}/pending-update.zip"
if [[ "${PACKAGE_PATH}" != "${EXPECTED_PACKAGE_PATH}" || ! -f "${PACKAGE_PATH}" ]]; then
  printf 'Update package must be %s\n' "${EXPECTED_PACKAGE_PATH}" >&2
  exit 1
fi

PARENT_DIR="$(dirname "${INSTALL_DIR}")"
DATA_DIR="${DATA_DIR:-/var/lib/healthflow-branch}"
LOG_DIR="${LOG_DIR:-/var/log/healthflow-branch}"
STATUS_PATH="${UPDATES_DIR}/status.json"
WORK_DIR="$(mktemp -d "${PARENT_DIR}/update-work-XXXXXX")"
BACKUP_DIR="${PARENT_DIR}/backup-$(date -u +%Y%m%d-%H%M%S)"
APP_BACKUP_DIR="${BACKUP_DIR}/application"
DATABASE_PATH="${HEALTHFLOW_DB_PATH:-${DATA_DIR}/healthflow-branch.sqlite}"
DATABASE_BACKUP_PATH="${BACKUP_DIR}/database/$(basename "${DATABASE_PATH}")"
LOG_PATH="${LOG_DIR}/update.log"
PAYLOAD_DIR=""
UPDATER_PATH="/usr/local/lib/healthflow/apply-update-linux.sh"

mkdir -p "${UPDATES_DIR}" "${LOG_DIR}"

write_status() {
  local state="$1"
  local message="$2"
  node -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      state: process.argv[2],
      message: process.argv[3],
      latestVersion: process.argv[4],
      updatedAt: new Date().toISOString()
    }, null, 2));
  ' "${STATUS_PATH}" "${state}" "${message}" "${EXPECTED_VERSION}"
  printf '[%s] %s - %s\n' "$(date -u +%FT%TZ)" "${state}" "${message}" >> "${LOG_PATH}"
  chown "${SERVICE_USER}:${SERVICE_USER}" "${STATUS_PATH}" "${LOG_PATH}" 2>/dev/null || true
}

stop_service() {
  systemctl stop "${SERVICE_NAME}"
  local deadline=$((SECONDS + 45))
  while systemctl is-active --quiet "${SERVICE_NAME}"; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out stopping %s.\n' "${SERVICE_NAME}" >&2
      return 1
    fi
    sleep 1
  done
}

start_service() {
  systemctl start "${SERVICE_NAME}"
  local deadline=$((SECONDS + 45))
  until systemctl is-active --quiet "${SERVICE_NAME}"; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out starting %s.\n' "${SERVICE_NAME}" >&2
      return 1
    fi
    sleep 1
  done
}

wait_for_health() {
  local branch_token="$1"
  local port="$2"
  local deadline=$((SECONDS + 45))
  until curl --fail --silent --show-error \
    -H "x-branch-token: ${branch_token}" \
    "http://127.0.0.1:${port}/health" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      printf 'Timed out waiting for the protected HealthFlow health endpoint.\n' >&2
      return 1
    fi
    sleep 2
  done
}

clear_application_files() {
  find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name '.env' \
    ! -name 'updates' \
    -exec rm -rf -- {} +
}

restore_backup() {
  [[ -d "${APP_BACKUP_DIR}" ]] || return 0
  clear_application_files
  cp -a "${APP_BACKUP_DIR}/." "${INSTALL_DIR}/"
  if [[ -f "${DATABASE_BACKUP_PATH}" ]]; then
    mkdir -p "$(dirname "${DATABASE_PATH}")"
    rm -f -- "${DATABASE_PATH}" "${DATABASE_PATH}-wal" "${DATABASE_PATH}-shm"
    for suffix in "" "-wal" "-shm"; do
      if [[ -f "${DATABASE_BACKUP_PATH}${suffix}" ]]; then
        cp -a "${DATABASE_BACKUP_PATH}${suffix}" "${DATABASE_PATH}${suffix}"
      fi
    done
  fi
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"
}

cleanup() {
  rm -rf -- "${WORK_DIR}"
  rm -f -- "${PACKAGE_PATH}"
}
trap cleanup EXIT

failure_message=""
run_update() {
  write_status "stopping_service" "Stopping ${SERVICE_NAME} and preparing the Linux update." || return 1
  stop_service || return 1

  unzip -q "${PACKAGE_PATH}" -d "${WORK_DIR}" || return 1

  PAYLOAD_DIR="${WORK_DIR}"
  if [[ ! -f "${PAYLOAD_DIR}/package.json" ]]; then
    mapfile -t children < <(find "${WORK_DIR}" -mindepth 1 -maxdepth 1 -type d)
    if [[ "${#children[@]}" -eq 1 && -f "${children[0]}/package.json" ]]; then
      PAYLOAD_DIR="${children[0]}"
    fi
  fi

  if [[ ! -f "${PAYLOAD_DIR}/package.json" ]]; then
    printf 'The update archive does not contain a branch-server package.json.\n' >&2
    return 1
  fi

  PAYLOAD_VERSION="$(
    node -e 'console.log(require(process.argv[1]).version)' "${PAYLOAD_DIR}/package.json"
  )" || return 1
  if [[ "${PAYLOAD_VERSION}" != "${EXPECTED_VERSION}" ]]; then
    printf 'Update archive version %s does not match expected version %s.\n' \
      "${PAYLOAD_VERSION}" "${EXPECTED_VERSION}" >&2
    return 1
  fi

  write_status "backing_up" "Backing up the application and local database." || return 1
  mkdir -p "${APP_BACKUP_DIR}" "$(dirname "${DATABASE_BACKUP_PATH}")" || return 1
  find "${INSTALL_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name '.env' \
    ! -name 'updates' \
    -exec cp -a --target-directory="${APP_BACKUP_DIR}" -- {} + || return 1
  if [[ -f "${DATABASE_PATH}" ]]; then
    for suffix in "" "-wal" "-shm"; do
      if [[ -f "${DATABASE_PATH}${suffix}" ]]; then
        cp -a "${DATABASE_PATH}${suffix}" "${DATABASE_BACKUP_PATH}${suffix}" || return 1
      fi
    done
  fi

  write_status "installing_files" "Installing verified application files." || return 1
  clear_application_files || return 1
  find "${PAYLOAD_DIR}" -mindepth 1 -maxdepth 1 \
    ! -name '.env' \
    ! -name 'data' \
    ! -name 'logs' \
    ! -name 'updates' \
    ! -name 'node_modules' \
    -exec cp -a --target-directory="${INSTALL_DIR}" -- {} + || return 1

  cd "${INSTALL_DIR}" || return 1
  write_status "installing_dependencies" "Installing production dependencies." || return 1
  npm ci --omit=dev || return 1
  npm run rebuild:sqlite || return 1
  chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}" "${DATA_DIR}" || return 1

  write_status "restarting" "Restarting ${SERVICE_NAME}." || return 1
  start_service || return 1
  systemctl is-active --quiet "${SERVICE_NAME}" || return 1
  BRANCH_TOKEN="$(sed -n 's/^BRANCH_SERVER_TOKEN=//p' "${INSTALL_DIR}/.env" | head -n 1)"
  PORT="$(sed -n 's/^PORT=//p' "${INSTALL_DIR}/.env" | head -n 1)"
  PORT="${PORT:-4780}"
  if [[ -z "${BRANCH_TOKEN}" ]]; then
    printf 'BRANCH_SERVER_TOKEN is missing after restart.\n' >&2
    return 1
  fi
  write_status "verifying" "Verifying the API and local database after restart." || return 1
  wait_for_health "${BRANCH_TOKEN}" "${PORT}" || return 1
  if [[ -f "${INSTALL_DIR}/scripts/apply-update-linux.sh" ]]; then
    install -o root -g root -m 0755 \
      "${INSTALL_DIR}/scripts/apply-update-linux.sh" \
      "${UPDATER_PATH}" || return 1
  fi

  write_status "installed" "HealthFlow ${EXPECTED_VERSION} installed successfully on Linux." || return 1
}

if ! run_update; then
  failure_message="Linux update installation failed."
  printf '%s\n' "${failure_message}" >> "${LOG_PATH}"
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  if restore_backup && start_service; then
    write_status "rolled_back" "${failure_message} The previous version was restored."
  else
    write_status "failed" "${failure_message} Automatic rollback also failed; manual support is required."
    exit 1
  fi
fi
