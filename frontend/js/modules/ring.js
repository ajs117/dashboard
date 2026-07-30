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

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    this._interval = Math.max(5, cfg.ring?.interval_seconds || 30) * 1000;
    this._sel = null;
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
        this._renderGrid(el, ctx);
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
    this._timer = setInterval(() => this._refreshImages(el), this._interval);
  },

  _renderGrid(el, ctx) {
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
    this._refreshImages(el);
  },

  // Cache-bust each fetch so WebKit doesn't reuse the previous frame; the backend caches
  // upstream for ring.interval_seconds, so this can't stampede Ring.
  // Fetch each snapshot via fetch() (not a bare <img src>) so we can read the
  // X-Snapshot-Age header and show how old the frame actually is — a wired camera's
  // battery "100%" told you nothing, whereas staleness is the thing you want to trust.
  async _refreshImages(el) {
    const stamp = Date.now();
    const imgs = Array.from(el.querySelectorAll("img[data-cam]"));
    for (const img of imgs) {
      const id = img.dataset.cam;
      const url = `/api/ring/snapshot/${encodeURIComponent(id)}?t=${stamp}`;
      const ageEl = el.querySelector(`.rc-age[data-age="${id}"]`);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const age = parseInt(res.headers.get("X-Snapshot-Age") || "", 10);
        const blob = await res.blob();
        const objUrl = URL.createObjectURL(blob);
        // Decode before swapping so the visible frame never blanks mid-refresh.
        await new Promise((done) => {
          const pre = new Image();
          pre.onload = pre.onerror = done;
          pre.src = objUrl;
        });
        if (img.dataset.objurl) URL.revokeObjectURL(img.dataset.objurl);  // free the old one
        img.dataset.objurl = objUrl;
        img.src = objUrl;
        img.classList.add("ready");
        if (ageEl) ageEl.textContent = Number.isFinite(age) ? agoText(age) : "now";
      } catch (e) {
        if (ageEl) ageEl.textContent = "no image";
        const wrap = img.closest(".rc-img");
        if (wrap && !wrap.querySelector(".rc-off") && !img.classList.contains("ready")) {
          wrap.innerHTML = `<div class="rc-off">No image</div>`;
        }
      }
    }
  },

  unmount() {
    clearInterval(this._timer);
    // Blob URLs are not garbage-collected while referenced - release them explicitly or
    // every refresh leaks a JPEG for as long as the page lives (512MB Pi).
    document.querySelectorAll("img[data-objurl]").forEach((img) => {
      URL.revokeObjectURL(img.dataset.objurl);
    });
  },
};
