// App shell: hash router, shared config, API helper, back button + status badge.
import { home } from "./modules/home.js";
import { aircraft } from "./modules/aircraft.js";
import { radar } from "./modules/radar.js";
import { trains } from "./modules/trains.js";
import { tracker } from "./modules/tracker.js";

const MODULES = { home, aircraft, radar, trains, tracker };

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
export function tap(el, fn) {
  if (!el) return;
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); fn(e); });
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
const view = () => document.getElementById("view");
const backBtn = () => document.getElementById("back-btn");

async function navigate(route) {
  if (!MODULES[route]) route = "home";
  // Ignore duplicate navigation to the same route. WPE/WebKit can fire an extra
  // hashchange on load, which would otherwise clear #view mid-mount.
  if (route === currentRoute && current) return;
  currentRoute = route;
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
}

boot();
