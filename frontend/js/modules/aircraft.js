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
  _map: null, _timer: null, _watchTimer: null, _markers: {}, _selected: null,
  _data: null, _follow: true, _focus: false, _wfMarker: null,

  async mount(el, ctx) {
    this._markers = {};
    this._selected = null;
    this._follow = true;
    el.innerHTML = `
      <div class="ac-layout">
        <div id="ac-map" class="full-map"></div>
        <div class="ac-side">
          <div class="ac-watch" id="ac-watch" hidden></div>
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
    // Watched flights (family travelling etc): looked up globally by callsign, so they show
    // regardless of whether they're anywhere near the map view.
    const loadWatch = async () => {
      try {
        const env = await ctx.api("/api/flights/watch");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        this._renderWatch(el, (env.data && env.data.flights) || []);
      } catch (e) { /* panel just stays hidden */ }
    };

    await load();
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    // Slow refresh (planes don't need per-second updates; respects the 1 req/s upstream).
    this._timer = setInterval(load, (ctx.config?.refresh?.aircraft || 20) * 1000);
    loadWatch();
    this._watchTimer = setInterval(loadWatch, 60000);   // watched flights move slowly
  },

  // Panel for the watched flights: route, progress bar, ETA. Hidden entirely when the
  // watch list is empty, so the page is unchanged for anyone not using the feature.
  _renderWatch(el, flights) {
    const box = el.querySelector("#ac-watch");
    if (!box) return;
    // Focus mode: while a flight is being watched, the page is ABOUT that flight. The
    // nearby-aircraft list, photo and look-angle panels are hidden - they're noise when
    // you're following family, and dropping them also takes a lot of weight off a 512MB
    // Pi (this page was the one logging WebKit load failures).
    const layout = el.querySelector(".ac-layout");
    this._focus = flights.length > 0;
    if (layout) layout.classList.toggle("focus", this._focus);
    if (!flights.length) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;

    // Put the map on the watched flight, wherever in the world it is.
    const pos = flights.find((f) => f.lat != null && f.lon != null);
    if (pos && this._map) {
      if (!this._wfMarker) {
        this._wfMarker = L.circleMarker([pos.lat, pos.lon], {
          radius: 9, color: "#fff", weight: 3, fillColor: "#4ea3ff", fillOpacity: 1,
        }).addTo(this._map);
      } else {
        this._wfMarker.setLatLng([pos.lat, pos.lon]);
      }
      // Only re-centre when it has actually moved a meaningful distance, so the map isn't
      // yanked around on every refresh.
      const c = this._map.getCenter();
      if (Math.abs(c.lat - pos.lat) > 0.5 || Math.abs(c.lng - pos.lon) > 0.5) {
        this._map.setView([pos.lat, pos.lon], Math.min(this._map.getZoom(), 5));
      }
    } else if (this._wfMarker && this._map) {
      this._map.removeLayer(this._wfMarker);
      this._wfMarker = null;
    }
    box.innerHTML = flights.map((f) => {
      const rt = f.route || {};
      const o = rt.origin || {}, d = rt.destination || {};
      const leg = (o.iata || d.iata)
        ? `${esc(o.iata || "?")} → ${esc(d.iata || "?")}`
        : `<span class="muted">route unknown</span>`;
      const where = (o.city || d.city) ? `${esc(o.city || "")} → ${esc(d.city || "")}` : "";
      let line, bar = "";
      if (f.status === "airborne" || f.status === "ground") {
        const bits = [];
        if (f.altitude != null) bits.push(`${Math.round(f.altitude).toLocaleString()} ft`);
        if (f.speed != null) bits.push(`${Math.round(f.speed)} kt`);
        if (f.distance_mi != null) bits.push(`${f.distance_mi} mi ${esc(f.compass || "")}`);
        line = bits.join(" · ");
        if (f.percent != null) {
          const eta = f.eta_minutes != null
            ? (f.eta_minutes >= 60
              ? `~${Math.floor(f.eta_minutes / 60)}h ${f.eta_minutes % 60}m left`
              : `~${f.eta_minutes}m left`)
            : (f.remaining_nm != null ? `${f.remaining_nm} nm left` : "");
          bar = `<div class="wf-bar"><i style="width:${f.percent}%"></i></div>`
            + `<div class="wf-eta">${f.percent}% · ${esc(eta)}</div>`;
        }
      } else if (f.status === "landed") {
        // Flight's done. Say so plainly and stop updating - it stays like this until a new
        // flight number is set on the remote page.
        line = `<span class="wf-landed">✅ Landed${d.city ? ` at ${esc(d.city)}` : ""}</span>`
          + `<br><span class="muted">set a new flight number on the remote page</span>`;
      } else if (f.status === "stale") {
        // Out of ADS-B coverage (typically mid-ocean) - say so rather than implying it's gone.
        line = `<span class="muted">no signal for ${f.last_seen_minutes ?? "?"} min`
          + `${f.percent != null ? ` · was ${f.percent}% along` : ""}</span>`;
      } else if (f.status === "error") {
        line = `<span class="muted">lookup failed</span>`;
      } else {
        // Can't distinguish "still on stand" from "flying but no receiver hears it", so
        // don't claim either. ADS-B here is volunteer-fed: thin over China/Siberia, dense
        // over Europe, so a long-haul often only appears for the last leg.
        line = `<span class="muted">no ADS-B contact${
          f.query_callsign ? ` for ${esc(f.query_callsign)}` : ""} right now`
          + `<br>coverage is thin outside Europe — it should appear as it gets closer</span>`;
      }
      // Full detail block, shown when you tap the flight.
      const det = [];
      if (f.registration) det.push(["Registration", f.registration]);
      if (f.type_name || f.type) det.push(["Aircraft", f.type_name || f.type]);
      if (f.altitude != null) det.push(["Altitude", `${Math.round(f.altitude).toLocaleString()} ft`]);
      if (f.speed != null) det.push(["Ground speed", `${Math.round(f.speed)} kt`]);
      if (f.heading != null) det.push(["Heading", `${Math.round(f.heading)}°`]);
      if (f.lat != null) det.push(["Position", `${f.lat.toFixed(2)}, ${f.lon.toFixed(2)}`]);
      if (f.distance_mi != null) det.push(["From you", `${f.distance_mi} mi ${f.compass || ""}`]);
      if (f.flown_nm != null) det.push(["Flown", `${f.flown_nm} nm`]);
      if (f.remaining_nm != null) det.push(["Remaining", `${f.remaining_nm} nm`]);
      if (o.name) det.push(["From", o.name]);
      if (d.name) det.push(["To", d.name]);
      if (rt.airline) det.push(["Airline", rt.airline]);
      const detHtml = det.length
        ? det.map(([k, v]) => `<div class="wf-d"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join("")
        : `<div class="wf-d muted">No live detail yet</div>`;
      return `<div class="wf" data-cs="${esc(f.callsign)}"
                   ${f.lat != null ? `data-lat="${f.lat}" data-lon="${f.lon}"` : ""}>
        <div class="wf-top"><span class="wf-cs">${esc(f.callsign)}</span>
          <span class="wf-leg">${leg}</span></div>
        ${where ? `<div class="wf-where">${where}</div>` : ""}
        <div class="wf-line">${line}</div>${bar}
        <div class="wf-details">${detHtml}</div>
      </div>`;
    }).join("");

    // Tap a watched flight -> zoom the map to it and reveal the full detail block.
    box.querySelectorAll(".wf").forEach((row) => {
      row.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        const open = row.classList.toggle("open");
        const lat = parseFloat(row.dataset.lat), lon = parseFloat(row.dataset.lon);
        if (open && this._map && Number.isFinite(lat) && Number.isFinite(lon)) {
          this._map.setView([lat, lon], 6);
        }
      });
    });
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
    // Focus mode: don't draw local traffic at all. It's not what you're looking at, and
    // every marker is memory this Pi would rather spend on not crashing.
    if (this._focus) {
      for (const hex of Object.keys(this._markers)) {
        this._map.removeLayer(this._markers[hex]);
        delete this._markers[hex];
      }
      return;
    }
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
      const ph = el.querySelector("#ac-photo");   // also clear the stale aircraft photo
      if (ph) { ph.style.backgroundImage = ""; ph.innerHTML = `<span class="muted">No aircraft in range</span>`; }
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
    clearInterval(this._watchTimer);
    if (this._map) { this._map.remove(); this._map = null; }
    this._markers = {};
  },
};
