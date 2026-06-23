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

# 2) Connectivity -> reconnect Wi-Fi only if the link is *really* down.
#    Lessons learnt the hard way: pinging public IPs (1.1.1.1/8.8.8.8) gives false
#    negatives (ISPs rate-limit/drop ICMP), and a single failed check used to trigger a
#    full `nmcli radio off/on` -- which on a marginal link caused a reconnect *storm*
#    (drop every ~60s), the very problem it was meant to fix. So:
#      - test the LAN gateway first (always answers when the link is genuinely up),
#      - require 3 consecutive failures (~3 min) before touching anything,
#      - escalate gently with `nmcli device reconnect`, never a radio bounce.
STATE=/run/dashboard-wd-netfail
GW="$(ip route 2>/dev/null | awk '/^default/{print $3; exit}')"
link_ok=0
if [ -n "$GW" ] && ping -c1 -W3 "$GW" >/dev/null 2>&1; then
  link_ok=1   # gateway reachable -> link is up
elif /usr/sbin/iw dev wlan0 link 2>/dev/null | grep -q "Connected to" \
     && { ping -c1 -W3 1.1.1.1 >/dev/null 2>&1 || ping -c1 -W3 8.8.8.8 >/dev/null 2>&1; }; then
  link_ok=1   # fallback: associated and the wider internet answers
fi

if [ "$link_ok" = 1 ]; then
  rm -f "$STATE"
else
  n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$STATE"
  log "connectivity check failed (${n}/3)"
  if [ "$n" -ge 3 ]; then
    log "no connectivity for ${n} checks -> reconnect wlan0"
    /usr/sbin/iw dev wlan0 set power_save off 2>/dev/null
    nmcli device reconnect wlan0 2>/dev/null \
      || { nmcli device disconnect wlan0 2>/dev/null; sleep 2; nmcli device connect wlan0 2>/dev/null; }
    rm -f "$STATE"
  fi
fi

# 3) Memory pressure -> restart the kiosk to shed any WebKit/WPE leak before an OOM.
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "${avail:-999}" -lt 55 ]; then
  log "low memory ${avail}MB -> restart dashboard-kiosk"
  systemctl restart dashboard-kiosk
fi
