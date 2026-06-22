#!/bin/bash
# Self-heal for the things the hardware watchdog can't catch: a dead backend, a dropped
# Wi-Fi link (system alive but unreachable), and memory pressure. Run every minute by
# dashboard-watchdog.timer. Best-effort: never exit non-zero in a way that masks state.
LOG=/var/log/dashboard-watchdog.log
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# keep the log small
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 200000 ]; then
  tail -n 200 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# 1) Backend health -> restart if it stops answering.
if ! curl -sf -m 8 -o /dev/null http://127.0.0.1:8080/healthz; then
  log "backend unhealthy -> restart dashboard-backend"
  systemctl restart dashboard-backend
fi

# 2) Connectivity -> reconnect Wi-Fi if the link is down.
if ! ping -c1 -W4 1.1.1.1 >/dev/null 2>&1 && ! ping -c1 -W4 8.8.8.8 >/dev/null 2>&1; then
  log "no connectivity -> Wi-Fi reconnect"
  iw dev wlan0 set power_save off 2>/dev/null
  nmcli radio wifi off 2>/dev/null; sleep 3; nmcli radio wifi on 2>/dev/null
  sleep 8
  if ! ping -c1 -W4 1.1.1.1 >/dev/null 2>&1; then
    log "still down -> nmcli device reconnect wlan0"
    nmcli device disconnect wlan0 2>/dev/null; sleep 2; nmcli device connect wlan0 2>/dev/null
  fi
fi

# 3) Memory pressure -> restart the kiosk to shed any WebKit/WPE leak before an OOM.
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "${avail:-999}" -lt 55 ]; then
  log "low memory ${avail}MB -> restart dashboard-kiosk"
  systemctl restart dashboard-kiosk
fi
