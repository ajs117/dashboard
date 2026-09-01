// Trains: National Rail live departure board, styled like a station CIS display.
import { esc } from "../util.js";

function expClass(etd, cancelled) {
  if (cancelled) return "exp-cancelled";
  if (!etd) return "";
  return etd.toLowerCase() === "on time" ? "exp-ontime" : "exp-late";
}

const HHMM = /^\d{1,2}:\d{2}$/;
const toMin = (t) => (HHMM.test(t || "") ? (+t.split(":")[0]) * 60 + (+t.split(":")[1]) : null);

// Minutes late, wrapping midnight: a train scheduled 23:58 arriving 00:04 is 6 late, not
// -1434. Anything beyond half a day is the wrap, not a genuinely enormous delay.
function lateBy(sched, actual) {
  const s = toMin(sched), a = toMin(actual);
  if (s == null || a == null) return null;
  let d = a - s;
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

// Where the train has actually got to: the last stop reported with a real arrival time.
function progressOf(stops) {
  let reached = -1;
  stops.forEach((s, i) => { if (HHMM.test(s.at || "")) reached = i; });
  return reached;
}

export const trains = {
  _timer: null, _clkTimer: null,

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    el.innerHTML = `<div class="trains" id="trains"><div class="board-loading muted">Loading departures…</div></div>`;
    // The board clock ticks every second on its own. It used to be written only inside
    // _render (i.e. once per 30s data refresh), so it looked frozen between fetches.
    const tickClock = () => {
      const clk = el.querySelector("#bh-clock");
      if (clk) clk.textContent = new Date().toLocaleTimeString("en-GB",
        { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    };
    this._clkTimer = setInterval(tickClock, 1000);
    const load = async () => {
      try {
        // A watched service takes over the whole page: when you have pushed a train, that
        // is the only thing you want to look at. Falls back to the board when it clears.
        const w = await ctx.api("/api/trains/watch").catch(() => null);
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        if (w && w.data) {
          const root = el.querySelector("#trains");
          if (!root) return;
          ctx.setStale(w.stale, "trains");
          this._renderWatch(root, w.data);
          return;
        }
        const env = await ctx.api("/api/trains");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const root = el.querySelector("#trains");
        if (!root) return;
        ctx.setStale(env.stale, "trains");
        this._render(root, env.data, cfg);
      } catch (e) {
        const root = el.querySelector("#trains");
        if (root) root.innerHTML =
          `<div class="err board-loading">Departures unavailable.<br>
           <span class="muted">Check the Darwin token / station code in config.</span></div>`;
      }
    };
    await load();
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    this._timer = setInterval(load, (cfg.refresh?.trains || 30) * 1000);
  },

  _render(el, d, cfg) {
    d = d || {};
    const services = d.services || [];
    const dest = (cfg.trains?.destination_crs || "").trim();
    // NRCC messages are free-text operator strings -> escape (highest XSS risk here).
    const messages = (d.messages || [])
      .map((m) => `<div class="nrcc">⚠️ ${esc(m)}</div>`).join("");

    const rows = services.map((s) => {
      const calling = (s.calling_points || []).map((c) => esc(c.name)).join(" • ");
      const inner = calling ? "Calling at: " + calling : esc(s.operator || "");
      const exp = s.cancelled ? "Cancelled" : esc(s.etd || "");
      return `
        <div class="brow ${s.cancelled ? "is-cancelled" : ""}">
          <div class="b-time">${esc(s.std || "")}</div>
          <div class="b-dest">
            <div class="dst">${esc(s.destination || "—")}</div>
            <div class="calling"><span class="ct">${inner}</span></div>
          </div>
          <div class="b-plat">${s.platform ? esc(s.platform) : "–"}</div>
          <div class="b-exp ${expClass(s.etd, s.cancelled)}">${exp}</div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <div class="board-head">
        <div class="bh-title">
          <span class="bh-station">${esc(d.station || "Departures")}</span>
          <span class="bh-crs">${esc(d.crs || "")}${dest ? " → " + esc(dest) : ""}</span>
        </div>
        <div class="bh-clock" id="bh-clock"></div>
      </div>
      ${messages}
      <div class="board">
        <div class="brow head">
          <div class="b-time">Time</div>
          <div class="b-dest">Destination</div>
          <div class="b-plat">Plat</div>
          <div class="b-exp">Expected</div>
        </div>
        <div class="board-rows">
          ${rows || `<div class="brow"><div class="b-dest muted">No departures listed</div></div>`}
        </div>
      </div>`;

    // Seed the clock immediately so it isn't blank until the next 1s tick.
    const clk = el.querySelector("#bh-clock");
    if (clk) clk.textContent = new Date().toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

    this._setupTickers(el);
  },

  // The followed service, drawn as a line diagram: a dot-matrix rail with a stop per
  // station and the train's real position along it. Between two stops the marker is
  // interpolated on the timetable, so it creeps forward instead of jumping station to
  // station - the whole point of watching is seeing it move.
  _renderWatch(el, d) {
    const stops = d.stops || [];
    if (stops.length < 2) { el.innerHTML = `<div class="board-loading muted">No route data</div>`; return; }
    const dest = stops[stops.length - 1];
    const reached = progressOf(stops);
    const arrived = HHMM.test(dest.at || "");
    const destEt = /on time/i.test(dest.et || "") ? dest.st : dest.et;
    const delay = lateBy(dest.st, dest.at || destEt);

    let status, scls;
    if (d.cancelled) { status = "Cancelled"; scls = "w-cancelled"; }
    else if (arrived) { status = "Arrived"; scls = "w-ontime"; }
    else if (delay == null) { status = "No report"; scls = "w-unknown"; }
    else if (delay <= 0) { status = "On time"; scls = "w-ontime"; }
    else { status = `${delay} min late`; scls = "w-late"; }

    const next = reached >= 0 && reached + 1 < stops.length ? stops[reached + 1] : null;
    const where = d.cancelled ? (d.cancel_reason || "This service is cancelled")
      : arrived ? `Arrived ${dest.at}`
      : next ? `Next stop ${next.name}` : "Awaiting departure";

    // Fractional position along the line, 0..n-1.
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    let pos = Math.max(0, reached);
    if (reached >= 0 && next) {
      const from = toMin(stops[reached].at) ?? toMin(stops[reached].st);
      const to = toMin(next.et) ?? toMin(next.st);
      if (from != null && to != null && to > from) {
        pos = reached + Math.min(1, Math.max(0, (nowMin - from) / (to - from)));
      }
    }
    const pct = (i) => (i / (stops.length - 1)) * 100;

    const dots = stops.map((s, i) => {
      const done = HHMM.test(s.at || "");
      const cls = done ? "done" : (next && i === reached + 1) ? "next" : "todo";
      const et = /on time/i.test(s.et || "") ? "" : s.et || "";
      const shown = s.at || et;
      const late = lateBy(s.st, shown);
      const tCls = late == null ? "" : late > 0 ? "exp-late" : "exp-ontime";
      return `
        <div class="trk-stop ${cls} ${s.cancelled ? "is-cancelled" : ""}" style="left:${pct(i).toFixed(2)}%">
          <div class="ts-time ${tCls}">${esc(shown || s.st || "")}</div>
          <span class="ts-dot"></span>
          <div class="ts-name">${esc(s.name || "")}</div>
        </div>`;
    }).join("");

    const trainPct = pct(pos);
    el.innerHTML = `
      <div class="board-head">
        <div class="bh-title">
          <span class="bh-station">${esc(dest.st || "")} ${esc(d.destination || "")}</span>
          <span class="bh-crs">from ${esc(d.origin || "")}${
            d.platform ? " · plat " + esc(d.platform) : ""}${
            d.operator ? " · " + esc(d.operator) : ""}</span>
        </div>
        <div class="bh-clock" id="bh-clock"></div>
      </div>
      <div class="wstat ${scls}">
        <div class="w-big">${esc(status)}</div>
        <div class="w-where">${esc(where)}</div>
        <button class="w-stop" id="w-stop">Stop watching</button>
      </div>
      ${d.delay_reason && !d.cancelled ? `<div class="nrcc">⚠️ ${esc(d.delay_reason)}</div>` : ""}
      <div class="track ${d.cancelled ? "is-cancelled" : ""}">
        <div class="trk-inner">
          <div class="trk-rail"></div>
          <div class="trk-fill" style="width:${trainPct.toFixed(2)}%"></div>
          ${dots}
          <div class="trk-train" style="left:${trainPct.toFixed(2)}%"><span>&#9646;&#9646;</span></div>
        </div>
      </div>`;

    const clk = el.querySelector("#bh-clock");
    if (clk) clk.textContent = new Date().toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
    const btn = el.querySelector("#w-stop");
    if (btn) btn.onclick = async () => {
      btn.textContent = "Stopping…";
      await fetch("/api/trains/watch", { method: "DELETE" }).catch(() => {});
    };
  },

  // Scroll the "calling at …" line like a real platform board, but only when it actually
  // overflows. Duplicate the text so the translateX(-50%) loop is seamless.
  _setupTickers(el) {
    el.querySelectorAll(".calling").forEach((c) => {
      const ct = c.querySelector(".ct");
      if (!ct) return;
      if (ct.scrollWidth > c.clientWidth + 4) {
        const txt = ct.innerHTML;
        ct.innerHTML = `${txt}<span class="ct-gap"></span>${txt}`;
        c.classList.add("scroll");
        ct.style.animationDuration = `${Math.max(10, (ct.scrollWidth / 2) / 38)}s`; // ~38px/s
      }
    });
  },

  unmount() { clearInterval(this._timer); clearInterval(this._clkTimer); },
};
