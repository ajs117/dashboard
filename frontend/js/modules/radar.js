// Radar: dark base map showing the CURRENT frame only + rain start/stop prediction.
/* global L */

export const radar = {
  _map: null, _layer: null, _refresh: null,

  async mount(el, ctx) {
    el.innerHTML = `
      <div id="radar-map" class="full-map"></div>
      <div class="rain-panel" id="rain-panel"><span class="muted">Checking rain…</span></div>`;

    const center = [
      ctx.config?.location?.lat ?? 51.5074,
      ctx.config?.location?.lon ?? -0.1278,
    ];
    const map = L.map("radar-map", { attributionControl: false, zoomControl: false })
      .setView(center, 7);
    L.control.zoom({ position: "bottomright" }).addTo(map);  // keep clear of Back button
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      maxZoom: 18,
    }).addTo(map);
    L.circleMarker(center, { radius: 6, color: "#4ea3ff", fillOpacity: 1 }).addTo(map);
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
        if (panel) this._renderPanel(panel, fc.data);
      } catch (e) {
        const panel = el.querySelector("#rain-panel");
        if (panel) panel.innerHTML = `<span class="muted">Forecast unavailable</span>`;
      }
    };
    await load();
    this._refresh = setInterval(load, (ctx.config?.refresh?.radar || 120) * 1000);
  },

  _showCurrent(data) {
    const frames = data.frames || [];
    if (!frames.length) return;
    // The newest *past* frame is "now".
    const idx = Math.max(0, (data.past_count || frames.length) - 1);
    const f = frames[idx];
    const url = `${data.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
    // RainViewer caps at z7 -> upscale those tiles past z7 instead of fetching placeholders.
    const layer = L.tileLayer(url, { opacity: 0.75, maxNativeZoom: 7, maxZoom: 18, zIndex: 5 });
    layer.addTo(this._map);
    if (this._layer) {
      const old = this._layer;
      setTimeout(() => this._map.removeLayer(old), 300); // brief overlap = no flicker
    }
    this._layer = layer;
  },

  _renderPanel(el, fc) {
    const raining = fc.raining_now;
    const big = raining
      ? `🌧️ Raining now <span class="lvl">(${fc.level})</span>`
      : `☀️ Dry now`;

    let line = "";
    const c = fc.change;
    const horizon = fc.horizon_min || 0;
    if (c && c.type === "start") {
      line = `<span class="start">Rain starting in ~${fc.minutes_until} min</span>`;
    } else if (c && c.type === "stop") {
      line = `<span class="stop">Rain stopping in ~${fc.minutes_until} min</span>`;
    } else if (horizon <= 0) {
      // No nowcast frames and no usable trend available right now.
      line = raining
        ? `<span class="muted">Rain over your location</span>`
        : `<span class="muted">No rain over your location</span>`;
    } else if (raining) {
      line = `<span class="muted">Rain continuing (next ${horizon} min)</span>`;
    } else {
      line = `<span class="muted">No rain expected (next ${horizon} min)</span>`;
    }
    const method = fc.method && fc.method !== "none"
      ? `<span class="method">via ${fc.method === "trend" ? "radar trend" : "nowcast"}</span>` : "";

    el.innerHTML = `
      <div class="rain-now">${big}</div>
      <div class="rain-next">${line}</div>
      ${this._spark(fc.series)}
      <div class="rain-foot">${fc.location || ""} ${method}</div>`;
  },

  _spark(series) {
    if (!series || !series.length) return "";
    const bars = series.map((s) => {
      const h = s.intensity == null ? 0 : (s.intensity / 3) * 100;
      const cls = s.intensity ? "on" : "off";
      return `<span class="bar ${cls}" style="height:${Math.max(6, h)}%"></span>`;
    }).join("");
    return `<div class="spark" title="past → now">${bars}</div>`;
  },

  unmount() {
    clearInterval(this._refresh);
    if (this._map) { this._map.remove(); this._map = null; }
    this._layer = null;
  },
};
