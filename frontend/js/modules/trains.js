// Trains: National Rail departure board.

function etdClass(etd, cancelled) {
  if (cancelled) return "etd-cancelled";
  if (!etd) return "";
  if (etd.toLowerCase() === "on time") return "etd-ontime";
  return "etd-late"; // a time or "Delayed"
}

export const trains = {
  _timer: null,

  async mount(el, ctx) {
    el.innerHTML = `<div class="trains" id="trains"><div class="muted">Loading departures…</div></div>`;
    const load = async () => {
      try {
        const env = await ctx.api("/api/trains");
        ctx.setStale(env.stale, "trains");
        this._render(el.querySelector("#trains"), env.data);
      } catch (e) {
        el.querySelector("#trains").innerHTML =
          `<div class="err">Departures unavailable.<br><span class="muted">
           Check the Darwin token / station code in config.</span></div>`;
      }
    };
    await load();
    this._timer = setInterval(load, (ctx.config?.refresh?.trains || 30) * 1000);
  },

  _render(el, d) {
    const services = d.services || [];
    const messages = (d.messages || []).map((m) => `<div class="nrcc">⚠️ ${m}</div>`).join("");
    const rows = services.map((s) => {
      const calling = (s.calling_points || [])
        .map((c) => c.name).slice(0, 6).join(", ");
      return `
        <div class="board-row">
          <div class="time">${s.std || ""}</div>
          <div>
            <div class="dest">${s.destination || "—"}</div>
            <div class="calling">${calling ? "Calling: " + calling : s.operator || ""}</div>
          </div>
          <div class="${etdClass(s.etd, s.cancelled)}">${s.cancelled ? "Cancelled" : (s.etd || "")}</div>
          <div>${s.platform ? "Plat " + s.platform : ""}</div>
        </div>`;
    }).join("");

    el.innerHTML = `
      <h2>${d.station || "Departures"}</h2>
      <div class="sub">${d.crs || ""}${d.generated_at ? " · updated " + d.generated_at.slice(11,16) : ""}</div>
      ${messages}
      <div class="board">
        <div class="board-row head">
          <div>Time</div><div>Destination</div><div>Expected</div><div>Plat</div>
        </div>
        ${rows || `<div class="board-row"><div class="muted">No departures listed</div></div>`}
      </div>`;
  },

  unmount() {
    clearInterval(this._timer);
  },
};
