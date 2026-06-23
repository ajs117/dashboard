// Radar: dark base map showing the CURRENT frame + rain-near-you prediction.
/* global L */
import { esc } from "../util.js";

export const radar = {
  _map: null, _layer: null, _refresh: null, _fade: null,

  async mount(el, ctx) {
    el.innerHTML = `
      <div id="radar-map" class="full-map"></div>
      <div class="rain-panel" id="rain-panel"><span class="muted">Checking rain…</span></div>`;

    this._units = ctx.config?.units || {};
    const center = [
      ctx.config?.location?.lat ?? 51.5074,
      ctx.config?.location?.lon ?? -0.1278,
    ];
    const map = L.map("radar-map", { attributionControl: false, zoomControl: false })
      .setView(center, 9);                       // zoomed in on your location
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "basemap-lite",     // lightened via CSS so it isn't near-black
    }).addTo(map);
    // marker + range rings (10/25/50 km) for a sense of distance
    L.circleMarker(center, { radius: 6, color: "#4ea3ff", fillOpacity: 1 }).addTo(map);
    [10000, 25000, 50000].forEach((m) =>
      L.circle(center, { radius: m, color: "#4ea3ff", weight: 1, opacity: 0.25, fill: false }).addTo(map));
    this._map = map;
    setTimeout(() => map.invalidateSize(), 50);

    const load = async () => {
      try {
        const env = await ctx.api("/api/radar");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        ctx.setStale(env.stale, "radar");
        this._showCurrent(env.data);
      } catch (e) { /* keep last layer */ }
      try {
        const fc = await ctx.api("/api/radar/forecast");
        const panel = el.querySelector("#rain-panel");
        if (panel) this._renderPanel(panel, fc.data, fc.stale);
      } catch (e) {
        const panel = el.querySelector("#rain-panel");
        if (panel) panel.innerHTML = `<span class="muted">Forecast unavailable</span>`;
      }
    };
    await load();
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    this._refresh = setInterval(load, (ctx.config?.refresh?.radar || 120) * 1000);
  },

  _showCurrent(data) {
    if (!this._map || !data) return;
    const frames = data.frames || [];
    if (!frames.length) return;
    // Prefer the last *past* frame; fall back to the last frame, always within bounds.
    const idx = data.past_count != null
      ? Math.min(frames.length - 1, Math.max(0, data.past_count - 1))
      : frames.length - 1;
    const f = frames[idx];
    const url = `${data.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
    const layer = L.tileLayer(url, { opacity: 0.8, maxNativeZoom: 7, maxZoom: 18, zIndex: 5 });
    layer.addTo(this._map);
    if (this._layer) {
      const old = this._layer;
      // crossfade: drop the old layer shortly after; cancel on unmount so it can't
      // fire against a torn-down map.
      clearTimeout(this._fade);
      this._fade = setTimeout(() => { if (this._map) this._map.removeLayer(old); }, 300);
    }
    this._layer = layer;
  },

  _fromDir(fc) {
    return fc.from_compass ? ` · from the ${esc(fc.from_compass)}` : "";
  },

  _renderPanel(el, fc, stale) {
    if (!fc) { el.innerHTML = `<span class="muted">Forecast unavailable</span>`; return; }
    let head, line, cls;
    switch (fc.status) {
      case "raining":
        cls = "r-now"; head = `🌧️ Raining now <span class="lvl">${esc(fc.level)}</span>`;
        line = fc.minutes_until_stop != null
          ? `<span class="soon">Stops in ~${fc.minutes_until_stop} min</span>`
          : `<span class="muted">Set in for the next couple of hours</span>`;
        break;
      case "starting":
        cls = "r-soon"; head = `🌧️ Rain soon`;
        line = `<span class="soon">Starts in ~${fc.minutes_until_start} min</span>${this._fromDir(fc)}`;
        break;
      default:
        cls = "r-dry"; head = `🌞 Dry`;
        line = `<span class="muted">No rain in the next 2 hours${fc.from_compass ? " · wind from the " + esc(fc.from_compass) : ""}</span>`;
    }
    el.className = `rain-panel ${cls}`;
    el.innerHTML = `
      <div class="rain-now">${head}</div>
      <div class="rain-next">${line}</div>
      ${this._timeline(fc.timeline)}
      <div class="rain-foot">${esc(fc.location || "")}${stale ? " · delayed" : ""}</div>`;
  },

  // Labelled next-2h precip chart (bar height = mm of rain per 15 min).
  _timeline(tl) {
    if (!tl || !tl.length) return "";
    const max = Math.max(0.5, ...tl.map((s) => s.mm || 0));   // scale; floor so light rain shows
    const anyRain = tl.some((s) => (s.mm || 0) > 0);
    const bars = tl.map((s) => {
      const mm = s.mm || 0;
      const h = mm > 0 ? Math.max(8, (mm / max) * 100) : 3;
      return `<span class="bar ${mm > 0 ? "on" : "off"}" style="height:${h}%"></span>`;
    }).join("");
    const caption = anyRain ? "Next 2h (rain)" : "Next 2h — no rain expected";
    return `<div class="spark">${bars}</div><div class="spark-cap">${caption}</div>`;
  },

  unmount() {
    clearInterval(this._refresh);
    clearTimeout(this._fade);
    if (this._map) { this._map.remove(); this._map = null; }
    this._layer = null;
  },
};
