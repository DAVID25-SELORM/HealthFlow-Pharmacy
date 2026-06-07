# HealthFlow Local Branch Server - Linux Installation

## Purpose

Linux can host the local branch server as a systemd service for a pharmacy, clinic, or hospital LAN.

## Requirements

- Ubuntu/Debian, RHEL/CentOS, or another systemd-based Linux distribution.
- Node.js 20 or newer.
- `python3`, `make`, and `g++` so `better-sqlite3` can compile for Linux.
- A completed `.env` based on `local-branch-server/.env.linux.example`.

Ubuntu/Debian packages:

```bash
sudo apt update
sudo apt install -y nodejs npm python3 make g++ rsync curl
```

## Install

1. Copy the repository or `local-branch-server` folder to the Linux machine.
2. Build the offline frontend bundle before handover:

   ```bash
   npm install
   npm run build:offline
   ```

3. Install the service:

   ```bash
   cd local-branch-server
   sudo bash scripts/install-linux-service.sh
   ```

4. Edit the environment file:

   ```bash
   sudo nano /opt/healthflow/local-branch-server/.env
   ```

5. Start and inspect:

   ```bash
   sudo systemctl start healthflow-branch
   sudo systemctl status healthflow-branch
   bash /opt/healthflow/local-branch-server/scripts/health-check.sh
   ```

## Runtime Paths

- Install directory: `/opt/healthflow/local-branch-server`
- Database directory: `/var/lib/healthflow-branch`
- Database file: `/var/lib/healthflow-branch/healthflow-branch.sqlite`
- Service user: `healthflow`
- Service name: `healthflow-branch`

## Firewall

Allow port `4780` only on the trusted LAN:

```bash
sudo ufw allow from 192.168.0.0/16 to any port 4780 proto tcp
```

Adjust the subnet for the facility network.

## Log Rotation

systemd captures logs in journald. Configure retention with journald or add a logrotate rule if logs are redirected to files. Minimum recommendation:

```bash
journalctl -u healthflow-branch --since today
```

## Update Process

1. Back up `/var/lib/healthflow-branch/healthflow-branch.sqlite`.
2. Copy new code.
3. Run `npm ci --omit=dev` inside `/opt/healthflow/local-branch-server`.
4. Run `npm run rebuild:sqlite`.
5. Restart:

   ```bash
   sudo systemctl restart healthflow-branch
   ```
