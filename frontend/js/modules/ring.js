// Ring: camera snapshot grid. Snapshots only (no live video — the kiosk's WPE build has
// no WebRTC stack). Polls ONLY while this page is mounted, so the Pi makes no Ring
// requests while you're on the home screen.
import { esc } from "../util.js";

// "updated Ns/Nm ago" for the snapshot age reported by the backend.
function agoText(sec) {
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

export const ring = {
  _timer: null, _cams: [], _interval: 30000, _sel: null,
  _run: 0, _refreshing: false, _el: null,

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    this._interval = Math.max(5, cfg.ring?.interval_seconds || 30) * 1000;
    this._sel = null;
    this._refreshing = false;
    this._el = el;
    const run = ++this._run;
    el.innerHTML = `<div class="ring" id="ring">
      <div class="ring-loading muted">Loading cameras…</div></div>`;

    const root = () => el.querySelector("#ring");

    const loadCams = async () => {
      try {
        const env = await ctx.api("/api/ring/cameras");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const d = env.data || {};
        if (!d.enabled) {
          root().innerHTML = `<div class="ring-loading muted">
            Ring isn't set up yet.<br>
            <span class="ring-hint">Run <code>deploy/scripts/ring_auth.py</code> on the Pi,
            then set <code>ring.enabled: true</code>.</span></div>`;
          return false;
        }
        this._cams = d.cameras || [];
        if (!this._cams.length) {
          root().innerHTML = `<div class="ring-loading muted">No cameras found${
            d.error ? `<br><span class="ring-hint">${esc(d.error)}</span>` : ""}</div>`;
          return false;
        }
        this._renderGrid(el, ctx, run);
        return true;
      } catch (e) {
        root().innerHTML = `<div class="err ring-loading">Cameras unavailable</div>`;
        return false;
      }
    };

    const ok = await loadCams();
    if (!ok) return;
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    // Refresh the images (not the camera list) on the configured interval.
    this._timer = setInterval(() => this._refreshImages(el, run), this._interval);
  },

  _renderGrid(el, ctx, run) {
    const root = el.querySelector("#ring");
    if (!root) return;
    const cards = this._cams.map((c) => {
      const off = !c.active;
      return `
      <div class="ring-cam ${off ? "is-off" : ""}" data-id="${esc(c.id)}">
        <div class="rc-img">
          ${off ? `<div class="rc-off">Camera off</div>`
                : `<img alt="${esc(c.name)}" data-cam="${esc(c.id)}">`}
        </div>
        <div class="rc-foot">
          <span class="rc-name">${esc(c.name)}</span>
          <span class="rc-age" data-age="${esc(c.id)}">${off ? "off" : "…"}</span>
        </div>
      </div>`;
    }).join("");
    root.innerHTML = `<div class="ring-grid">${cards}</div>`;
    // Tap a camera to enlarge it (and back again).
    root.querySelectorAll(".ring-cam").forEach((card) => {
      ctx.tap(card, () => {
        const id = card.dataset.id;
        this._sel = this._sel === id ? null : id;
        root.querySelectorAll(".ring-cam").forEach((c) =>
          c.classList.toggle("is-big", this._sel === c.dataset.id));
        root.querySelector(".ring-grid").classList.toggle("has-big", !!this._sel);
      });
    });
    this._refreshImages(el, run);
  },

  // Cache-bust each fetch so WebKit doesn't reuse the previous frame; the backend caches
  // upstream for ring.interval_seconds, so this can't stampede Ring.
  // Fetch each snapshot via fetch() (not a bare <img src>) so we can read the
  // X-Snapshot-Age header and show how old the frame actually is — a wired camera's
  // battery "100%" told you nothing, whereas staleness is the thing you want to trust.
  async _refreshImages(el, run) {
    if (run !== this._run || this._refreshing) return;
    this._refreshing = true;
    const stamp = Date.now();
    const imgs = Array.from(el.querySelectorAll("img[data-cam]"));
    try {
      for (const img of imgs) {
        const id = img.dataset.cam;
        const url = `/api/ring/snapshot/${encodeURIComponent(id)}?t=${stamp}`;
        const ageEl = Array.from(el.querySelectorAll(".rc-age[data-age]"))
          .find((node) => node.dataset.age === id);
        let objUrl = null;
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(String(res.status));
          const age = parseInt(res.headers.get("X-Snapshot-Age") || "", 10);
          const blob = await res.blob();
          if (run !== this._run || !img.isConnected) continue;
          objUrl = URL.createObjectURL(blob);
          // Decode before swapping so the visible frame never blanks mid-refresh.
          const decoded = await new Promise((done) => {
            const pre = new Image();
            pre.onload = () => done(true);
            pre.onerror = () => done(false);
            pre.src = objUrl;
          });
          if (!decoded) throw new Error("snapshot decode failed");
          if (run !== this._run || !img.isConnected) {
            URL.revokeObjectURL(objUrl);
            objUrl = null;
            continue;
          }
          if (img.dataset.objurl) URL.revokeObjectURL(img.dataset.objurl);
          const nextUrl = objUrl;
          img.dataset.objurl = nextUrl;
          img.src = nextUrl;
          objUrl = null;                            // ownership transferred to the <img>
          img.classList.add("ready");
          if (ageEl) ageEl.textContent = Number.isFinite(age) ? agoText(age) : "now";
        } catch (e) {
          if (objUrl) URL.revokeObjectURL(objUrl);
          if (run !== this._run || !img.isConnected) continue;
          if (ageEl) ageEl.textContent = "no image";
          const wrap = img.closest(".rc-img");
          if (wrap && !wrap.querySelector(".rc-off") && !img.classList.contains("ready")) {
            wrap.innerHTML = `<div class="rc-off">No image</div>`;
          }
        }
      }
    } finally {
      if (run === this._run) this._refreshing = false;
    }
  },

  unmount() {
    clearInterval(this._timer);
    this._run += 1;                  // invalidates fetch/decode work still in flight
    this._refreshing = false;
    // Blob URLs are not garbage-collected while referenced - release them explicitly or
    // every refresh leaks a JPEG for as long as the page lives (512MB Pi).
    (this._el || document).querySelectorAll("img[data-objurl]").forEach((img) => {
      URL.revokeObjectURL(img.dataset.objurl);
    });
    this._el = null;
  },
};
