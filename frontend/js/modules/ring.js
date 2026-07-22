// Ring: camera snapshot grid. Snapshots only (no live video — the kiosk's WPE build has
// no WebRTC stack). Polls ONLY while this page is mounted, so the Pi makes no Ring
// requests while you're on the home screen.
import { esc } from "../util.js";

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
          ${c.battery != null ? `<span class="rc-bat">${c.battery}%</span>` : ""}
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
  _refreshImages(el) {
    const stamp = Date.now();
    el.querySelectorAll("img[data-cam]").forEach((img) => {
      img.src = `/api/ring/snapshot/${encodeURIComponent(img.dataset.cam)}?t=${stamp}`;
      img.onerror = () => {
        const wrap = img.closest(".rc-img");
        if (wrap && !wrap.querySelector(".rc-off")) {
          wrap.innerHTML = `<div class="rc-off">No image</div>`;
        }
      };
    });
  },

  unmount() { clearInterval(this._timer); },
};
