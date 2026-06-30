// Trains: National Rail live departure board, styled like a station CIS display.
import { esc } from "../util.js";

function expClass(etd, cancelled) {
  if (cancelled) return "exp-cancelled";
  if (!etd) return "";
  return etd.toLowerCase() === "on time" ? "exp-ontime" : "exp-late";
}

export const trains = {
  _timer: null,

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    el.innerHTML = `<div class="trains" id="trains"><div class="muted" style="padding:24px">Loading departures…</div></div>`;
    const load = async () => {
      try {
        const env = await ctx.api("/api/trains");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const root = el.querySelector("#trains");
        if (!root) return;
        ctx.setStale(env.stale, "trains");
        this._render(root, env.data, cfg);
      } catch (e) {
        const root = el.querySelector("#trains");
        if (root) root.innerHTML =
          `<div class="err" style="padding:24px">Departures unavailable.<br>
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

    const clk = el.querySelector("#bh-clock");
    if (clk) clk.textContent = new Date().toLocaleTimeString("en-GB",
      { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

    this._setupTickers(el);
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

  unmount() { clearInterval(this._timer); },
};
