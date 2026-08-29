// Radar: dark base map showing the CURRENT frame + rain-near-you prediction.
/* global L */
import { esc } from "../util.js";
import { radarNowcast } from "./rainNowcast.js";

export const radar = {
  _map: null, _layer: null, _refresh: null, _fade: null, _upwind: null, _framePath: null,

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
    // Green, not blue: the rain echo itself is blue/cyan, so a blue dot vanished into it.
    // White outline keeps it readable over heavy (orange/yellow) echo too.
    L.circleMarker(center, { radius: 6, color: "#ffffff", weight: 2,
      fillColor: "#22dd55", fillOpacity: 1 }).addTo(map);
    [10000, 25000, 50000].forEach((m) =>
      L.circle(center, { radius: m, color: "#4ea3ff", weight: 1, opacity: 0.25, fill: false }).addTo(map));
    this._map = map;
    setTimeout(() => map.invalidateSize(), 50);

    // Green line from your location pointing at where the weather is coming FROM: look
    // along it to see what is heading your way. Drawn whenever the field's movement can be
    // measured (or, failing that, from the model's wind direction) - it shows movement, not
    // rain, so it belongs on a dry map too.
    this._drawUpwind = (from, motion, windDirDeg) => {
      if (this._upwind) { this._upwind.forEach((l) => this._map.removeLayer(l)); this._upwind = null; }
      const map = this._map;
      if (!map) return;
      const layers = [];

      let ux, uy;
      if (motion && (motion.dx || motion.dy)) {
        const len = Math.hypot(motion.dx, motion.dy) || 1;
        ux = -motion.dx / len; uy = -motion.dy / len;      // upwind = against the motion
      } else if (windDirDeg != null) {
        // Met convention: wind_dir already IS the direction it comes from, so use it as-is.
        const rad = (windDirDeg * Math.PI) / 180;
        ux = Math.sin(rad); uy = -Math.cos(rad);
      }

      if (ux !== undefined) {
        const pFrom = map.latLngToLayerPoint(from);
        // Tip sits where the air reaching us in an hour is right now, so the length is to
        // scale; with only a wind direction there is no distance to draw, so use a stub.
        let drawLen = 90;
        if (motion && motion.hour_lat != null) {
          const pHour = map.latLngToLayerPoint([motion.hour_lat, motion.hour_lon]);
          drawLen = Math.hypot(pHour.x - pFrom.x, pHour.y - pFrom.y);
        }
        // Start clear of the location dot so the line reads as separate from it.
        const start = map.layerPointToLatLng(L.point(pFrom.x + ux * 16, pFrom.y + uy * 16));
        const end = map.layerPointToLatLng(L.point(pFrom.x + ux * drawLen, pFrom.y + uy * drawLen));
        layers.push(L.polyline([start, end], {
          color: "#22dd55", weight: 4, opacity: 0.95,      // green, matching the location dot
        }).addTo(map));
      }

      this._upwind = layers.length ? layers : null;
    };

    const load = async () => {
      let env = null;
      try {
        env = await ctx.api("/api/radar");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        ctx.setStale(env.stale, "radar");
        this._showCurrent(env.data);
      } catch (e) { /* keep last layer */ }
      try {
        const fc = await ctx.api("/api/radar/forecast");
        // Prefer the real radar sampled at our location (the model misses live rain);
        // fall back to the server forecast if radar sampling can't produce one.
        let data = fc.data, stale = fc.stale;
        const rn = env && env.data ? await radarNowcast(env.data, center[0], center[1]) : null;
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        if (rn) {
          data = { ...rn, location: (fc.data && fc.data.location) || ctx.config?.location?.label || "" };
          stale = false;
        }
        this._drawUpwind(center, rn && rn.motion, fc.data && fc.data.wind_dir);
        const panel = el.querySelector("#rain-panel");
        if (panel) this._renderPanel(panel, data, stale);
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
    if (f.path === this._framePath) return;       // do not rebuild an unchanged tile layer
    const url = `${data.host}${f.path}/256/{z}/{x}/{y}/4/1_1.png`;
    // crossOrigin so the browser caches a CORS-clean response — rainNowcast samples these
    // same tiles in a canvas, which taints (and throws on read) if they were cached non-CORS.
    const layer = L.tileLayer(url, {
      opacity: 0.8, maxNativeZoom: 7, maxZoom: 18, zIndex: 5, crossOrigin: "anonymous",
    });
    const old = this._layer;
    if (old) {
      // Keep the last working frame until the replacement's visible tiles have loaded.
      // A bounded fallback avoids retaining it forever if Leaflet never emits `load`.
      clearTimeout(this._fade);
      const removeOld = () => {
        clearTimeout(this._fade);
        if (this._map && this._map.hasLayer(old)) this._map.removeLayer(old);
      };
      layer.once("load", removeOld);
      this._fade = setTimeout(removeOld, 5000);
    }
    layer.addTo(this._map);
    this._layer = layer;
    this._framePath = f.path;
  },

  // Which way the weather is coming from and how fast. Shown in every state, raining
  // included - that is the line you check against what the map is doing.
  _movement(fc) {
    if (!fc.from_compass) return "";
    const kmh = fc.motion && fc.motion.speed_kmh;
    return `<div class="rain-move">Coming from the ${esc(fc.from_compass)}${
      kmh ? ` · ${kmh} km/h` : ""}</div>`;
  },

  _renderPanel(el, fc, stale) {
    if (!fc) { el.innerHTML = `<span class="muted">Forecast unavailable</span>`; return; }
    let head, line, cls;
    switch (fc.status) {
      case "raining":
        cls = "r-now"; head = `🌧️ Raining now <span class="lvl">${esc(fc.level)}</span>`;
        line = fc.minutes_until_stop != null
          ? `<span class="soon">Stops in ~${fc.minutes_until_stop} min</span>`
          : `<span class="muted">${fc.horizon_minutes > 0
            ? `Still raining in ${fc.horizon_minutes} min`
            : "Duration uncertain"}</span>`;
        break;
      case "starting":
        cls = "r-soon"; head = `🌧️ Rain soon`;
        line = `<span class="soon">Starts in ~${fc.minutes_until_start} min</span>`;
        break;
      default:
        cls = "r-dry"; head = `🌞 Dry`;
        line = `<span class="muted">No rain in the next ${
          fc.horizon_minutes == null ? "2 hours" : `${fc.horizon_minutes} min`}</span>`;
    }
    el.className = `rain-panel ${cls}`;
    el.innerHTML = `
      <div class="rain-now">${head}</div>
      <div class="rain-next">${line}</div>
      ${this._movement(fc)}
      ${this._timeline(fc.timeline, fc.horizon_minutes)}
      <div class="rain-foot">${esc(fc.location || "")}${stale ? " · delayed" : ""}</div>`;
  },

  // Precip bars over the trustworthy horizon (radar coverage can make it shorter than 2h),
  // with a time scale under them - bars of equal height and no axis said nothing at all.
  _timeline(tl, horizonMinutes) {
    if (!tl || tl.length < 2) return "";
    const max = Math.max(0.5, ...tl.map((s) => s.mm || 0));   // scale; floor so light rain shows
    const bars = tl.map((s) => {
      const mm = s.mm || 0;
      const h = mm > 0 ? Math.max(8, (mm / max) * 100) : 3;
      return `<span class="bar ${mm > 0 ? "on" : "off"}" style="height:${h}%"></span>`;
    }).join("");
    if (horizonMinutes == null || horizonMinutes <= 0) return `<div class="spark">${bars}</div>`;
    // Ticks at round intervals placed proportionally, rather than a label at the midpoint:
    // the horizon shrinks as the field speeds up (the upwind sample runs out of window), so
    // the midpoint is usually an odd number like 50m and reads as a glitch.
    const every = horizonMinutes > 90 ? 30 : horizonMinutes > 45 ? 20 : 10;
    const ticks = [];
    for (let m = every; m <= horizonMinutes; m += every) {
      const at = (m / horizonMinutes) * 100;
      const place = at >= 95 ? `right:0` : `left:${at.toFixed(1)}%;transform:translateX(-50%)`;
      ticks.push(`<span style="${place}">${m}m</span>`);
    }
    return `<div class="spark">${bars}</div>
      <div class="spark-scale"><span class="t0">now</span>${ticks.join("")}</div>`;
  },

  unmount() {
    clearInterval(this._refresh);
    clearTimeout(this._fade);
    if (this._map) { this._map.remove(); this._map = null; }
    this._layer = null;
    this._framePath = null;
    this._upwind = null;      // layers died with the map; drop the refs
  },
};
