// Small shared helpers.

const _ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape a value for safe interpolation into innerHTML. All upstream/API-derived
// strings (callsigns, station/airport names, NRCC messages, etc.) must go through this
// before landing in a template literal — this is an unattended kiosk, treat data as hostile.
export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => _ESC[c]);
}

// True only for a plain http(s) URL, so a malicious "thumbnail" can't smuggle
// javascript:/data: or break out of a CSS url("...").
export function safeHttpUrl(u) {
  return typeof u === "string" && /^https?:\/\/[^"'()\s]+$/i.test(u) ? u : null;
}
