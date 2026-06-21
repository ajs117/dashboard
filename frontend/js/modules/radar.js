// Radar: dark base map showing the CURRENT frame + rain-near-you prediction.
/* global L */

export const radar = {
  _map: null, _layer: null, _refresh: null,

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
    this._refresh = setInterval(load, (ctx.config?.refresh?.radar || 120) * 1000);
  },

  _showCurrent(data) {
    const frames = data.frames || [];
    if (!frames.length) return;
    const idx = Math.max(0, (data.past_count || frames.length) - 1);
    const f = frames[idx];
    const url = `${data.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
    const layer = L.tileLayer(url, { opacity: 0.8, maxNativeZoom: 7, maxZoom: 18, zIndex: 5 });
    layer.addTo(this._map);
    if (this._layer) {
      const old = this._layer;
      setTimeout(() => this._map.removeLayer(old), 300);
    }
    this._layer = layer;
  },

  _dist(km) {
    if (km == null) return "";
    const u = this._units?.distance || "km";
    if (u === "mi") return (km * 0.621371).toFixed(1) + " mi";
    if (u === "nm") return (km / 1.852).toFixed(1) + " nm";
    return km.toFixed(1) + " km";
  },

  _renderPanel(el, fc, stale) {
    const km = fc.nearest_km;
    let head, line, cls;
    switch (fc.status) {
      case "raining":
        cls = "r-now"; head = `🌧️ Raining now`;
        line = `<span class="lvl">${fc.level}</span>`;
        break;
      case "approaching":
        cls = "r-soon"; head = `🌧️ Rain approaching`;
        line = fc.minutes_until != null
          ? `<span class="soon">~${fc.minutes_until} min away</span> · ${this._dist(km)}`
          : `<span class="soon">~${this._dist(km)} away, closing in</span>`;
        break;
      case "nearby":
        cls = "r-near"; head = `🌦️ Rain nearby`;
        line = `<span class="near">~${this._dist(km)} away</span>`;
        break;
      default:
        cls = "r-dry"; head = `☀️ Dry`;
        line = `<span class="muted">No rain nearby</span>`;
    }
    el.className = `rain-panel ${cls}`;
    el.innerHTML = `
      <div class="rain-now">${head}</div>
      <div class="rain-next">${line}</div>
      ${this._spark(fc.series)}
      <div class="rain-foot">${fc.location || ""}${stale ? " · delayed" : ""}</div>`;
  },

  _spark(series) {
    if (!series || !series.length) return "";
    // bar height from how close the nearest rain is (closer = taller); none = flat
    const bars = series.map((s) => {
      let h = 6, on = "off";
      if (s.center_alpha >= 25) { h = 100; on = "on"; }
      else if (s.nearest_km != null) { h = Math.max(10, 100 - s.nearest_km * 1.4); on = "near"; }
      return `<span class="bar ${on}" style="height:${h}%"></span>`;
    }).join("");
    return `<div class="spark" title="rain proximity, past → now">${bars}</div>`;
  },

  unmount() {
    clearInterval(this._refresh);
    if (this._map) { this._map.remove(); this._map = null; }
    this._layer = null;
  },
};
