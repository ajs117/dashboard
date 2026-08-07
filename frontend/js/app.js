// App shell: hash router, shared config, API helper, back button + status badge.
import { home } from "./modules/home.js";
import { aircraft } from "./modules/aircraft.js";
import { radar } from "./modules/radar.js";
import { trains } from "./modules/trains.js";
import { tracker } from "./modules/tracker.js";
import { ring } from "./modules/ring.js";

const MODULES = { home, aircraft, radar, trains, tracker, ring };

export const state = { config: null };

// --- API helper: returns {data, stale, age, error} envelope from the backend. ---
export async function api(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

// Fast, accurate tap for nav targets: fire on first contact (pointerdown), before a
// cheap touch panel's coordinate drifts during the hold, and preventDefault to suppress
// the synthesized click so we don't "ghost-tap" whatever lands under the point next.
// Only use on non-scrolling targets (tiles, Back) — preventDefault would block panning.
// WebKit follows every touch with a synthesized COMPATIBILITY MOUSE event, and on this
// panel that second event carries a drifted coordinate. Both reached tap(), so a single
// press fired twice on two different targets: the first opened the tile you touched, the
// second immediately navigated somewhere else - the "I pressed Trains and got another
// module" symptom, and the reason a press on the app menu selected a random row.
// preventDefault on pointerdown does NOT suppress those compatibility events, so filter by
// pointerType instead. Once a genuine touch has been seen we ignore mouse pointers
// entirely; the flag keeps a real mouse working for desktop development.
let sawTouch = false;
function isRealPress(e) {
  if (e.pointerType === "touch") { sawTouch = true; return true; }
  return !sawTouch;
}

export function tap(el, fn) {
  if (!el) return;
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!isRealPress(e)) return;
    fn(e);
  });
}

// Tap for rows inside a SCROLLABLE list: fire on pointerup only if the finger didn't
// move (so a drag still scrolls). No preventDefault, so panning keeps working.
export function tapRow(el, fn) {
  if (!el) return;
  let sx = 0, sy = 0, moved = false;
  el.addEventListener("pointerdown", (e) => { sx = e.clientX; sy = e.clientY; moved = false; });
  el.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > 12) moved = true;
  });
  el.addEventListener("pointerup", (e) => { if (!moved) fn(e); });
}

// "stale data" badge (top-right).
export function setStale(stale, msg) {
  const el = document.getElementById("status");
  if (!el) return;
  el.innerHTML = stale
    ? `<span class="stale-badge">stale${msg ? " · " + msg : ""}</span>`
    : "";
}

let current = null;
let currentRoute = null;
let navToken = 0;

// --- Post-navigation input guard ------------------------------------------------------
// Navigation happens on pointerdown (this touch panel's release coordinate is unreliable),
// so the new page mounts while the finger is still down. The panel then emits bounce
// events that land on whatever just appeared - pressing Back would arrive home and
// immediately open the app menu, and vice versa. Swallow input briefly after any
// navigation, in ONE place, so no module has to defend itself.
const NAV_GUARD_MS = 900;
let navGuardUntil = 0;
document.addEventListener("pointerdown", (e) => {
  if (Date.now() < navGuardUntil) { e.stopPropagation(); e.preventDefault(); }
}, true);   // capture: runs before any module's own handler

const view = () => document.getElementById("view");
const backBtn = () => document.getElementById("back-btn");

// Rate-limit: a duplicated press could otherwise navigate twice in quick succession, the
// second hop landing on whatever the drifted coordinate hit. First navigation wins, so you
// always get the target you actually pressed.
let lastNavAt = 0;

async function navigate(route) {
  if (!MODULES[route]) route = "home";
  // Ignore duplicate navigation to the same route. WPE/WebKit can fire an extra
  // hashchange on load, which would otherwise clear #view mid-mount.
  if (route === currentRoute && current) return;
  const nowMs = Date.now();
  if (nowMs - lastNavAt < 500) return;
  lastNavAt = nowMs;
  currentRoute = route;
  navGuardUntil = Date.now() + NAV_GUARD_MS;   // ignore the touch that triggered this nav
  const myToken = ++navToken;          // invalidates any in-flight async work
  if (current && current.unmount) {
    try { current.unmount(); } catch (e) { /* ignore */ }
  }
  setStale(false);
  backBtn().hidden = route === "home";   // back button only inside an app
  view().innerHTML = "";
  current = MODULES[route];
  const ctx = {
    config: state.config, api, setStale, go, tap, tapRow,
    isCurrent: () => myToken === navToken,   // false once superseded
  };
  try {
    await current.mount(view(), ctx);
  } catch (e) {
    if (myToken === navToken) {
      view().innerHTML = `<div class="err">Failed to load ${route}: ${e.message}</div>`;
    }
  }
}

// Exposed to modules (e.g. home launcher tiles) to change route.
export function go(route) {
  location.hash = route;
}

// Poll the remote-control command channel so a phone/laptop can drive this screen
// (navigate to an app, reload). Acts only when the sequence number advances.
function startRemotePoll() {
  let lastSeq = -1;
  const poll = async () => {
    try {
      const c = await api("/api/remote/cmd");
      if (lastSeq === -1) { lastSeq = c.seq; return; }   // ignore the command present at boot
      // React to ANY change, not just an increase: the backend's seq resets to 0 on a
      // restart, so ">" would wedge the kiosk (it remembers a higher number) and ignore
      // every later command. "!==" recovers; a no-op seq 0 has action null, so it's safe.
      if (c.seq !== lastSeq) {
        lastSeq = c.seq;
        if (c.action === "reload") location.reload();
        else if (c.action === "go" && c.value) go(c.value);
      }
    } catch (e) { /* ignore; try again next tick */ }
  };
  setInterval(poll, 2000);
  poll();
}

async function boot() {
  tap(backBtn(), () => go("home"));
  window.addEventListener("hashchange", () =>
    navigate(location.hash.replace("#", "") || "home")
  );
  try {
    state.config = await api("/api/config");
  } catch (e) {
    state.config = {};
  }
  navigate(location.hash.replace("#", "") || "home");
  startRemotePoll();
}

boot();
