#!/bin/bash
# Idempotent resiliency hardening for the desk-dashboard Pi.
#
# Additive: it does NOT rewrite the working backend/kiosk units — it augments them with
# drop-ins and adds self-heal/watchdog/reboot/journal/wifi pieces. Safe to re-run.
#
#   sudo bash deploy/scripts/harden-pi.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash $0"; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"   # the deploy/ directory
SD=/etc/systemd/system

echo "[1/6] Wi-Fi: disable power save (persistent) — the most likely drop cause"
install -D -m644 "$REPO/systemd/wifi-powersave-off.conf" /etc/NetworkManager/conf.d/wifi-powersave-off.conf
install -m644 "$REPO/systemd/dashboard-wifi-powersave.service" "$SD/dashboard-wifi-powersave.service"
iw dev wlan0 set power_save off 2>/dev/null || true

echo "[2/6] journald: capped persistent logs (diagnose future crashes across reboots)"
install -D -m644 "$REPO/systemd/journald-persistent.conf" /etc/systemd/journald.conf.d/persistent.conf

echo "[3/6] hardware watchdog: auto-reboot on a full system hang"
install -D -m644 "$REPO/systemd/10-watchdog.conf" /etc/systemd/system.conf.d/10-watchdog.conf

echo "[4/6] self-heal timer: backend / Wi-Fi / memory every minute"
install -m755 "$REPO/scripts/dashboard-watchdog.sh" /usr/local/bin/dashboard-watchdog.sh
install -m644 "$REPO/systemd/dashboard-watchdog.service" "$SD/dashboard-watchdog.service"
install -m644 "$REPO/systemd/dashboard-watchdog.timer" "$SD/dashboard-watchdog.timer"

echo "[5/6] nightly reboot: clear accumulated leaks at 04:30"
install -m644 "$REPO/systemd/dashboard-reboot.service" "$SD/dashboard-reboot.service"
install -m644 "$REPO/systemd/dashboard-reboot.timer" "$SD/dashboard-reboot.timer"

echo "[6/6] services: never give up restarting"
for u in dashboard-backend dashboard-kiosk; do
  if [ -f "$SD/$u.service" ]; then
    install -d "$SD/$u.service.d"
    cat > "$SD/$u.service.d/restart.conf" <<'DROP'
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=always
RestartSec=3
DROP
  fi
done

# The OS image ships two zram managers: systemd-zram-generator (which already creates and
# mounts /dev/zram0) and zram-tools' zramswap.service, which then fails on boot trying to
# grab the already-mounted device ("Device busy"). Mask the redundant one — zram swap still
# works via the generator; this just removes the scary boot failure.
if systemctl list-unit-files zramswap.service >/dev/null 2>&1; then
  systemctl disable --now zramswap.service 2>/dev/null || true
  systemctl mask zramswap.service 2>/dev/null || true
fi

systemctl daemon-reload
systemctl restart systemd-journald
systemctl enable --now dashboard-wifi-powersave.service
systemctl enable --now dashboard-watchdog.timer
systemctl enable --now dashboard-reboot.timer
systemctl daemon-reexec   # apply the RuntimeWatchdogSec change to PID 1

echo
echo "==== applied ===="
echo "hw watchdog : $(systemctl show -p RuntimeWatchdogUSec --value)"
echo "wifi psave  : $(iw dev wlan0 get power_save 2>/dev/null || echo '?')"
systemctl --no-pager list-timers dashboard-watchdog.timer dashboard-reboot.timer 2>/dev/null | head -4 || true
