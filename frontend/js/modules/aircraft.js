// Aircraft: dark Leaflet map, nearest list, + selected-plane "where to look" panel.
// By default it auto-follows the closest airborne aircraft; tapping a row pins that one.
/* global L */
import { esc, safeHttpUrl } from "../util.js";

// Plane silhouette drawn pointing NORTH (up), so rotate(heading) aims it correctly.
const PLANE_PATH =
  "M12 2 L13.2 9 L21 14 L21 15.5 L13.2 12.5 L13 18 L15.5 20 L15.5 21.2 " +
  "L12 20 L8.5 21.2 L8.5 20 L11 18 L10.8 12.5 L3 15.5 L3 14 L10.8 9 Z";
const _norm = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

export const aircraft = {
  _map: null, _timer: null, _markers: {}, _selected: null, _data: null, _follow: true,

  async mount(el, ctx) {
    this._markers = {};
    this._selected = null;
    this._follow = true;
    el.innerHTML = `
      <div class="ac-layout">
        <div id="ac-map" class="full-map"></div>
        <div class="ac-side">
          <div class="ac-photo" id="ac-photo"><span class="muted">Select an aircraft</span></div>
          <div class="ac-sky" id="ac-sky"></div>
          <div class="ac-detail" id="ac-detail"><div class="muted">No aircraft in range</div></div>
          <div class="ac-list" id="ac-list"></div>
        </div>
      </div>`;

    const center = [
      ctx.config?.location?.lat ?? 51.5074,
      ctx.config?.location?.lon ?? -0.1278,
    ];
    const map = L.map("ac-map", { attributionControl: false, zoomControl: false })
      .setView(center, 11);
    L.control.zoom({ position: "bottomright" }).addTo(map);  // keep clear of Back button
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "basemap-lite",
    }).addTo(map);
    L.circleMarker(center, { radius: 6, color: "#4ea3ff", fillOpacity: 1 })
      .addTo(map).bindTooltip("You");
    this._map = map;
    setTimeout(() => map.invalidateSize(), 50);
    // The list + auto-follow mirror what's actually on screen, so re-evaluate both when the
    // view pans/zooms (otherwise the detail panel can show a plane that's off the map).
    map.on("moveend zoomend", () => { this._renderList(el, ctx); this._refollow(el, ctx); });

    const load = async () => {
      try {
        const env = await ctx.api("/api/aircraft");
        if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away mid-fetch
        if (!el.querySelector("#ac-list")) return;        // view replaced
        ctx.setStale(env.stale, "aircraft");
        this._data = env.data;
        this._render(el, ctx);
      } catch (e) {
        const list = el.querySelector("#ac-list");
        if (list) list.innerHTML = `<div class="err">Aircraft unavailable</div>`;
      }
    };
    await load();
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    // Slow refresh (planes don't need per-second updates; respects the 1 req/s upstream).
    this._timer = setInterval(load, (ctx.config?.refresh?.aircraft || 20) * 1000);
  },

  // Aircraft currently inside the map viewport (nearest-first, as the backend orders them).
  // Auto-follow/selection is restricted to these so the side panel always matches the map.
  _visible(data) {
    const list = data?.aircraft || [];
    if (!this._map) return list;
    const b = this._map.getBounds();
    return list.filter((a) => a.lat != null && a.lon != null && b.contains([a.lat, a.lon]));
  },

  _pickClosest(data) {
    const list = this._visible(data);      // only planes you can actually see
    if (!list.length) return null;
    const airborne = list.find((a) => (a.altitude || 0) > 0);
    return (airborne || list[0]).hex;
  },

  // Follow the closest, but only switch to a new aircraft if it's clearly nearer than the
  // one we're already on — hysteresis stops the selection flip-flopping (and reloading
  // route/photo) every refresh when two planes trade places for "closest".
  _followTarget(data) {
    const closest = this._pickClosest(data);
    if (!closest) return null;
    const vis = this._visible(data);
    const cur = vis.find((a) => a.hex === this._selected);
    if (!cur) return closest;        // selection left the view (or none) -> closest visible
    const closestAc = vis.find((a) => a.hex === closest);
    const curD = cur.distance_mi ?? Infinity;
    const closeD = closestAc?.distance_mi ?? Infinity;
    return closeD < curD * 0.85 ? closest : this._selected;
  },

  // Re-evaluate the auto-followed plane after a pan/zoom so the detail panel never shows a
  // plane that's off the visible map. No-op while a plane is pinned (deliberate selection).
  _refollow(el, ctx) {
    if (!this._data || !this._follow) return;
    const target = this._followTarget(this._data);
    if (!target) {
      if (this._selected) { this._selected = null; this._repaintMarkers(); this._renderDetail(el, null); }
    } else if (target !== this._selected) {
      this._select(el, ctx, target);
    }
  },

  // ✈ SVG marker; selected/nearest plane is yellow, others light grey.
  _iconFor(ac) {
    const sel = ac.hex === this._selected;
    const html = `<svg class="plane-svg ${sel ? "sel" : ""}" viewBox="0 0 24 24" `
      + `width="28" height="28" style="transform:rotate(${ac.heading || 0}deg)">`
      + `<path d="${PLANE_PATH}"/></svg>`;
    return L.divIcon({ html, className: "", iconSize: [28, 28], iconAnchor: [14, 14] });
  },

  _render(el, ctx) {
    const data = this._data;
    const list = el.querySelector("#ac-list");
    if (!list) return;
    if (!data || !Array.isArray(data.aircraft)) {     // null/error envelope -> don't crash
      list.innerHTML = `<div class="muted" style="padding:16px">No aircraft data</div>`;
      return;
    }
    const seen = new Set();

    for (const ac of data.aircraft) {
      seen.add(ac.hex);
      const icon = this._iconFor(ac);
      let m = this._markers[ac.hex];
      if (m) { m.setLatLng([ac.lat, ac.lon]); m.setIcon(icon); }
      else {
        m = L.marker([ac.lat, ac.lon], { icon }).addTo(this._map);
        m.on("click", () => { this._follow = false; this._select(el, ctx, ac.hex); });
        this._markers[ac.hex] = m;
      }
    }
    for (const hex of Object.keys(this._markers)) {
      if (!seen.has(hex)) { this._map.removeLayer(this._markers[hex]); delete this._markers[hex]; }
    }

    this._renderList(el, ctx);

    // Decide which plane to show: keep a still-present pinned plane, else auto-follow.
    let target;
    if (!this._follow && data.aircraft.some((a) => a.hex === this._selected)) {
      target = this._selected;                  // pinned and still in range
    } else {
      this._follow = true;                      // pinned plane gone, or already following
      target = this._followTarget(data);
    }

    if (!target) {
      this._selected = null;
      this._renderDetail(el, null);
    } else if (target !== this._selected) {
      this._select(el, ctx, target);            // changed plane -> (re)load route + photo
    } else {
      this._renderLive(el);                      // same plane -> just refresh live numbers
    }
  },

  // Build the side list from only the aircraft currently within the map viewport, so the
  // list matches what you can see. Re-run on every pan/zoom and data refresh.
  _renderList(el, ctx) {
    const list = el.querySelector("#ac-list");
    if (!list || !this._map) return;
    const bounds = this._map.getBounds();
    const visible = (this._data?.aircraft || []).filter(
      (ac) => ac.lat != null && ac.lon != null && bounds.contains([ac.lat, ac.lon]));

    list.innerHTML = visible.map((ac) => `
      <div class="ac-row ${ac.hex === this._selected ? "sel" : ""}" data-hex="${esc(ac.hex)}">
        <div><div class="cs">${esc(ac.callsign || ac.hex)}</div>
          <div class="meta">${esc(ac.type || "?")} · ${esc(ac.compass || "")} ${ac.elevation || 0}°↑</div></div>
        <div style="text-align:right">
          <div>${ac.distance_mi ?? "—"} mi</div>
          <div class="meta">${ac.altitude != null ? ac.altitude + " ft" : ""}</div></div>
      </div>`).join("") ||
      `<div class="muted" style="padding:16px">No aircraft in this area</div>`;

    // Rows live in a scrollable list -> movement-thresholded tap so a drag still scrolls.
    list.querySelectorAll(".ac-row").forEach((row) =>
      ctx.tapRow(row, () => { this._follow = false; this._select(el, ctx, row.dataset.hex); }));
  },

  _select(el, ctx, hex) {
    this._selected = hex;
    this._highlightRows(el);
    this._repaintMarkers();
    const ac = (this._data?.aircraft || []).find((a) => a.hex === hex);
    this._renderDetail(el, ac);
    this._loadPhoto(el, ctx, hex);
    this._loadRoute(el, ctx, ac?.callsign);
  },

  // Same plane still selected: update the look panel + live grid, keep route/photo/airline.
  _renderLive(el) {
    const ac = (this._data?.aircraft || []).find((a) => a.hex === this._selected);
    if (!ac) return;
    const sky = el.querySelector("#ac-sky");
    if (sky) this._renderLook(sky, ac);
    const grid = el.querySelector("#ac-grid");
    if (grid) grid.innerHTML = this._gridHtml(ac);
    this._repaintMarkers();
    this._highlightRows(el);
  },

  _highlightRows(el) {
    el.querySelectorAll(".ac-row").forEach((r) =>
      r.classList.toggle("sel", r.dataset.hex === this._selected));
  },

  _repaintMarkers() {
    for (const ac of this._data?.aircraft || []) {
      const m = this._markers[ac.hex];
      if (m) m.setIcon(this._iconFor(ac));
    }
  },

  _renderLook(sky, ac) {
    sky.innerHTML = `
      <div class="look-grid">
        <div class="look-item"><div class="lk">Look</div>
          <div class="lv">${esc(ac.compass || "?")} <span class="u">${ac.azimuth ?? "?"}°</span></div></div>
        <div class="look-item"><div class="lk">Up</div>
          <div class="lv">${ac.elevation ?? 0}<span class="u">°</span></div></div>
        <div class="look-item"><div class="lk">Distance</div>
          <div class="lv">${ac.distance_mi ?? "—"}<span class="u"> mi</span></div></div>
      </div>`;
  },

  _gridHtml(ac) {
    // Don't print the registration twice (private flights broadcast reg as callsign,
    // e.g. callsign "GGBVN" vs reg "G-GBVN") — compare alphanumerics only.
    const regShown = ac.registration && _norm(ac.registration) !== _norm(ac.callsign);
    return `
      <div class="k">Aircraft</div><div>${esc(ac.type || "—")}${regShown ? " · " + esc(ac.registration) : ""}</div>
      <div class="k">Altitude</div><div>${ac.altitude != null ? ac.altitude.toLocaleString() + " ft" : "—"}</div>
      <div class="k">Speed</div><div>${ac.speed != null ? Math.round(ac.speed) + " kt" : "—"}</div>
      <div class="k">Heading</div><div>${ac.heading != null ? Math.round(ac.heading) + "°" : "—"}</div>`;
  },

  _renderDetail(el, ac) {
    const sky = el.querySelector("#ac-sky");
    const d = el.querySelector("#ac-detail");
    if (!sky || !d) return;
    if (!ac) {
      sky.innerHTML = "";
      d.innerHTML = `<div class="muted">No aircraft in range</div>`;
      return;
    }
    this._renderLook(sky, ac);
    d.innerHTML = `
      <div class="ac-flight">
        <span class="cs">${esc(ac.callsign || ac.hex)}</span>
        <span class="airline" id="ac-airline"></span>
      </div>
      <div class="ac-route" id="ac-route"><span class="muted">looking up route…</span></div>
      <div class="grid" id="ac-grid">${this._gridHtml(ac)}</div>`;
  },

  async _loadRoute(el, ctx, callsign) {
    const r = el.querySelector("#ac-route");
    if (!r) return;
    callsign = (callsign || "").trim();
    if (!callsign) { r.innerHTML = `<span class="muted">No flight number</span>`; return; }
    r.innerHTML = `<span class="muted">looking up route…</span>`;
    try {
      const env = await ctx.api(`/api/route/${encodeURIComponent(callsign)}`);
      const sel = (this._data?.aircraft || []).find((a) => a.hex === this._selected);
      if (!sel || (sel.callsign || "").trim() !== callsign) return;   // selection changed
      const route = el.querySelector("#ac-route");
      const al = el.querySelector("#ac-airline");
      if (!route) return;
      const d = env.data;
      if (d && (d.origin || d.destination)) {
        const o = d.origin || {}, ds = d.destination || {};
        route.innerHTML = `
          <span class="ap"><b>${esc(o.iata || "???")}</b><small>${esc(o.city || o.name || "")}</small></span>
          <span class="arrow">✈</span>
          <span class="ap"><b>${esc(ds.iata || "???")}</b><small>${esc(ds.city || ds.name || "")}</small></span>`;
        if (al) al.textContent = d.airline || "";   // textContent -> already safe
      } else {
        route.innerHTML = `<span class="muted">Route not available</span>`;
      }
    } catch (e) {
      const route = el.querySelector("#ac-route");
      if (route) route.innerHTML = `<span class="muted">Route not available</span>`;
    }
  },

  async _loadPhoto(el, ctx, hex) {
    const ph = el.querySelector("#ac-photo");
    ph.style.backgroundImage = "";
    ph.innerHTML = `<span class="muted">Loading photo…</span>`;
    try {
      const env = await ctx.api(`/api/aircraft/${encodeURIComponent(hex)}/photo`);
      if (hex !== this._selected) return;
      const p = env.data;
      const url = p && safeHttpUrl(p.thumbnail);   // reject non-http(s) / CSS-breaking URLs
      if (url) {
        ph.style.backgroundImage = `url("${url}")`;
        ph.innerHTML = `<div class="credit">© ${esc(p.photographer || "Planespotters")}</div>`;
      } else {
        ph.innerHTML = `<span class="muted">No photo available</span>`;
      }
    } catch (e) {
      ph.innerHTML = `<span class="muted">No photo</span>`;
    }
  },

  unmount() {
    clearInterval(this._timer);
    if (this._map) { this._map.remove(); this._map = null; }
    this._markers = {};
  },
};
