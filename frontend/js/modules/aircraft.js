// Aircraft: dark Leaflet map, nearest list, + selected-plane "where to look" panel.
/* global L */

export const aircraft = {
  _map: null, _timer: null, _markers: {}, _selected: null, _data: null,

  async mount(el, ctx) {
    this._markers = {};
    this._selected = null;
    el.innerHTML = `
      <div class="ac-layout">
        <div id="ac-map" class="full-map"></div>
        <div class="ac-side">
          <div class="ac-photo" id="ac-photo"><span class="muted">Select an aircraft</span></div>
          <div class="ac-sky" id="ac-sky"></div>
          <div class="ac-detail" id="ac-detail"><div class="muted">No selection</div></div>
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
    // Dark base map, lightened via CSS filter so it isn't near-black.
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      maxZoom: 18, className: "basemap-lite",
    }).addTo(map);
    L.circleMarker(center, { radius: 6, color: "#4ea3ff", fillOpacity: 1 })
      .addTo(map).bindTooltip("You");
    this._map = map;
    setTimeout(() => map.invalidateSize(), 50);

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
    this._timer = setInterval(load, (ctx.config?.refresh?.aircraft || 8) * 1000);
  },

  _render(el, ctx) {
    const data = this._data;
    const list = el.querySelector("#ac-list");
    const seen = new Set();

    for (const ac of data.aircraft) {
      seen.add(ac.hex);
      const icon = this._iconFor(ac);
      let m = this._markers[ac.hex];
      if (m) { m.setLatLng([ac.lat, ac.lon]); m.setIcon(icon); }
      else {
        m = L.marker([ac.lat, ac.lon], { icon }).addTo(this._map);
        m.on("click", () => this._select(el, ctx, ac.hex));
        this._markers[ac.hex] = m;
      }
    }
    for (const hex of Object.keys(this._markers)) {
      if (!seen.has(hex)) { this._map.removeLayer(this._markers[hex]); delete this._markers[hex]; }
    }

    list.innerHTML = data.aircraft.map((ac) => `
      <div class="ac-row ${ac.hex === this._selected ? "sel" : ""}" data-hex="${ac.hex}">
        <div><div class="cs">${ac.callsign || ac.hex}</div>
          <div class="meta">${ac.type || "?"} · ${ac.compass || ""} ${ac.elevation || 0}°↑</div></div>
        <div style="text-align:right">
          <div>${ac.distance_mi} mi</div>
          <div class="meta">${ac.altitude != null ? ac.altitude + " ft" : ""}</div></div>
      </div>`).join("") ||
      `<div class="muted" style="padding:16px">No aircraft in range</div>`;

    list.querySelectorAll(".ac-row").forEach((row) =>
      row.addEventListener("click", () => this._select(el, ctx, row.dataset.hex)));

    if (!this._selected && data.aircraft.length) {
      // Prefer the nearest airborne aircraft (skip ground vehicles) for "where to look".
      const airborne = data.aircraft.find((a) => (a.altitude || 0) > 0);
      this._select(el, ctx, (airborne || data.aircraft[0]).hex);
    } else if (this._selected) {
      this._renderDetail(el);
    }
  },

  // ✈ text glyph (recolourable, unlike the multicolour emoji). Nose points NW (~315°),
  // so add 45° to make heading 0 point north (up). Selected/nearest plane is yellow.
  _iconFor(ac) {
    const sel = ac.hex === this._selected;
    const html = `<div class="plane-icon ${sel ? "sel" : ""}" `
      + `style="transform:rotate(${(ac.heading || 0) + 45}deg)">✈</div>`;
    return L.divIcon({ html, className: "", iconSize: [26, 26] });
  },

  _select(el, ctx, hex) {
    this._selected = hex;
    el.querySelectorAll(".ac-row").forEach((r) =>
      r.classList.toggle("sel", r.dataset.hex === hex));
    for (const ac of this._data?.aircraft || []) {     // repaint markers (yellow = selected)
      const m = this._markers[ac.hex];
      if (m) m.setIcon(this._iconFor(ac));
    }
    this._renderDetail(el);
    this._loadPhoto(el, ctx, hex);
    const ac = (this._data?.aircraft || []).find((a) => a.hex === hex);
    this._loadRoute(el, ctx, ac?.callsign);
  },

  _renderDetail(el) {
    const ac = (this._data?.aircraft || []).find((a) => a.hex === this._selected);
    const sky = el.querySelector("#ac-sky");
    const d = el.querySelector("#ac-detail");
    if (!sky || !d) return;
    if (!ac) { sky.innerHTML = ""; d.innerHTML = `<div class="muted">No selection</div>`; return; }

    // "Where to look" panel — direction, elevation and distance carry equal weight.
    sky.innerHTML = `
      <div class="look-grid">
        <div class="look-item"><div class="lk">Look</div>
          <div class="lv">${ac.compass || "?"} <span class="u">${ac.azimuth ?? "?"}°</span></div></div>
        <div class="look-item"><div class="lk">Up</div>
          <div class="lv">${ac.elevation ?? 0}<span class="u">°</span></div></div>
        <div class="look-item"><div class="lk">Distance</div>
          <div class="lv">${ac.distance_mi}<span class="u"> mi</span></div></div>
      </div>`;

    // Avoid printing the registration twice (private flights broadcast reg as callsign,
    // e.g. callsign "GGBVN" vs reg "G-GBVN") — compare alphanumerics only.
    const norm = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const regShown = ac.registration && norm(ac.registration) !== norm(ac.callsign);
    d.innerHTML = `
      <div class="ac-flight">
        <span class="cs">${ac.callsign || ac.hex}</span>
        <span class="airline" id="ac-airline"></span>
      </div>
      <div class="ac-route" id="ac-route"><span class="muted">looking up route…</span></div>
      <div class="grid">
        <div class="k">Aircraft</div><div>${ac.type || "—"}${regShown ? " · " + ac.registration : ""}</div>
        <div class="k">Altitude</div><div>${ac.altitude != null ? ac.altitude.toLocaleString() + " ft" : "—"}</div>
        <div class="k">Speed</div><div>${ac.speed != null ? Math.round(ac.speed) + " kt" : "—"}</div>
        <div class="k">Heading</div><div>${ac.heading != null ? Math.round(ac.heading) + "°" : "—"}</div>
      </div>`;
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
          <span class="ap"><b>${o.iata || "???"}</b><small>${o.city || o.name || ""}</small></span>
          <span class="arrow">✈</span>
          <span class="ap"><b>${ds.iata || "???"}</b><small>${ds.city || ds.name || ""}</small></span>`;
        if (al) al.textContent = d.airline || "";
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
      const env = await ctx.api(`/api/aircraft/${hex}/photo`);
      if (hex !== this._selected) return;
      const p = env.data;
      if (p && p.thumbnail) {
        ph.style.backgroundImage = `url("${p.thumbnail}")`;
        ph.innerHTML = `<div class="credit">© ${p.photographer || "Planespotters"}</div>`;
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
