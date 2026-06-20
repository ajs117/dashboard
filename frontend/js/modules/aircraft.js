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
      .setView(center, 9);
    L.control.zoom({ position: "bottomright" }).addTo(map);  // keep clear of Back button
    // Dark base map (matches the working-light setup).
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
      maxZoom: 18,
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
      const html = `<div class="plane-icon" style="transform:rotate(${ac.heading || 0}deg)">✈️</div>`;
      const icon = L.divIcon({ html, className: "", iconSize: [24, 24] });
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

  _select(el, ctx, hex) {
    this._selected = hex;
    el.querySelectorAll(".ac-row").forEach((r) =>
      r.classList.toggle("sel", r.dataset.hex === hex));
    this._renderDetail(el);
    this._loadPhoto(el, ctx, hex);
    const ac = (this._data?.aircraft || []).find((a) => a.hex === hex);
    this._loadRoute(el, ctx, ac?.callsign);
  },

  _renderDetail(el) {
    const ac = (this._data?.aircraft || []).find((a) => a.hex === this._selected);
    const sky = el.querySelector("#ac-sky");
    const d = el.querySelector("#ac-detail");
    if (!ac) { sky.innerHTML = ""; d.innerHTML = `<div class="muted">No selection</div>`; return; }

    // "Where to look" panel.
    sky.innerHTML = `
      <div class="look-big">${ac.compass || "?"} <span class="deg">${ac.azimuth ?? "?"}°</span></div>
      <div class="look-sub">${ac.elevation ?? 0}° above horizon · ${ac.distance_mi} mi away</div>`;

    d.innerHTML = `
      <div class="cs">${ac.callsign || ac.hex}</div>
      <div class="route" id="ac-route"><span class="muted">route…</span></div>
      <div class="grid">
        <div class="k">Type</div><div>${ac.type || "—"}</div>
        <div class="k">Reg</div><div>${ac.registration || "—"}</div>
        <div class="k">Altitude</div><div>${ac.altitude != null ? ac.altitude + " ft" : "—"}</div>
        <div class="k">Speed</div><div>${ac.speed != null ? Math.round(ac.speed) + " kt" : "—"}</div>
        <div class="k">Heading</div><div>${ac.heading != null ? Math.round(ac.heading) + "°" : "—"}</div>
        <div class="k">Distance</div><div>${ac.distance_mi} mi</div>
      </div>`;
  },

  async _loadRoute(el, ctx, callsign) {
    const r = el.querySelector("#ac-route");
    if (!r) return;
    if (!callsign) { r.innerHTML = `<span class="muted">No callsign</span>`; return; }
    r.innerHTML = `<span class="muted">route…</span>`;
    try {
      const env = await ctx.api(`/api/route/${encodeURIComponent(callsign.trim())}`);
      if (callsign !== (this._data?.aircraft || []).find((a) => a.hex === this._selected)?.callsign)
        return;
      const d = env.data;
      if (d && (d.origin || d.destination)) {
        const o = d.origin?.iata || d.origin?.city || "?";
        const dst = d.destination?.iata || d.destination?.city || "?";
        r.innerHTML = `<span class="ap">${o}</span> → <span class="ap">${dst}</span>
          ${d.airline ? `<span class="muted"> · ${d.airline}</span>` : ""}`;
      } else {
        r.innerHTML = `<span class="muted">Route unknown</span>`;
      }
    } catch (e) {
      r.innerHTML = `<span class="muted">Route unknown</span>`;
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
