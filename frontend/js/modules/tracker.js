// Tracker: custom "watch this" routines. First one is the TUI holiday price.
// All trackers are auto-polled (the holiday searchId is refreshed in config), so there's
// no manual price entry — each card just offers a "Check now" to force an immediate poll.
import { esc } from "../util.js";

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

const money = (v, unit) =>
  v == null ? "—" : (unit || "") + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

function ago(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function sparkline(history) {
  const pts = (history || []).map((h) => h[1]).filter((v) => v != null);
  if (pts.length < 2) return `<div class="trk-spark muted">not enough history yet</div>`;
  const min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const W = 280, H = 44;
  const d = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((v - min) / span) * (H - 6) - 3;
    return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg class="trk-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="#4ea3ff" stroke-width="2"/></svg>`;
}

export const tracker = {
  _timer: null,

  async mount(el, ctx) {
    el.innerHTML = `<div class="tracker"><div class="trk-list" id="trk-list">
      <div class="muted" style="padding:24px">Loading trackers…</div></div></div>`;

    const load = async () => {
      try {
        const data = await ctx.api("/api/trackers");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        if (!el.querySelector("#trk-list")) return;
        this._render(el, ctx, data);
      } catch (e) {
        const list = el.querySelector("#trk-list");
        if (list) list.innerHTML = `<div class="err">Trackers unavailable</div>`;
      }
    };
    await load();
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    this._timer = setInterval(load, 60000);
  },

  _render(el, ctx, data) {
    const list = el.querySelector("#trk-list");
    if (!list) return;
    const trackers = (data && data.trackers) || [];
    if (!trackers.length) {
      list.innerHTML = `<div class="muted" style="padding:24px">No trackers configured.</div>`;
      return;
    }
    // Order: parcels first, DVLA licence last, everything else (holiday) between.
    const rank = (t) => (t.id.startsWith("parcel:") ? 0 : t.id === "dvla" ? 2 : 1);
    trackers.sort((a, b) => rank(a) - rank(b));
    list.innerHTML = trackers.map((t) => {
      const al = t.alert && t.alert.active ? t.alert : null;
      const isStatus = t.status != null;              // DVLA-style status tracker
      let valueCell, body, banner;
      if (isStatus) {
        valueCell = `<div class="trk-statuswrap">
            <div class="trk-status ${t.value === 0 ? "bad" : "ok"}">${esc(t.status)}</div>
            ${t.detail ? `<div class="trk-detail muted">${esc(t.detail)}</div>` : ""}</div>`;
        body = "";
        banner = al ? `<div class="trk-banner change">
            Status changed → ${esc(al.to)}
            <button class="trk-btn ack" data-id="${esc(t.id)}">Dismiss</button></div>` : "";
      } else {
        const up = (t.change ?? 0) > 0, down = (t.change ?? 0) < 0;
        const chCls = up ? "up" : down ? "down" : "";
        const chTxt = t.change == null || t.change === 0 ? "no change since baseline"
          : `${up ? "▲" : "▼"} ${money(Math.abs(t.change), t.unit)} vs baseline`;
        valueCell = `<div class="trk-value">${money(t.value, t.unit)}
            <div class="trk-change ${chCls}">${chTxt}</div></div>`;
        body = sparkline(t.history);
        banner = al ? `<div class="trk-banner ${al.direction}">
            Price went ${al.direction === "up" ? "UP" : "DOWN"}
            ${money(Math.abs(al.delta), t.unit)} (now ${money(al.to, t.unit)})
            <button class="trk-btn ack" data-id="${esc(t.id)}">Dismiss</button></div>` : "";
      }
      return `
        <div class="trk-card ${al ? "trk-alerting" : ""}" data-id="${esc(t.id)}">
          <div class="trk-top">
            <div>
              <div class="trk-label">${esc(t.label)}</div>
              <div class="trk-note">${esc(t.note || "")}</div>
            </div>
            ${isStatus ? "" : valueCell}
          </div>
          ${isStatus ? valueCell : body}
          ${banner}
          <div class="trk-foot">
            <span class="muted">updated ${ago(t.updated_at)}${isStatus ? "" : ` · baseline ${money(t.baseline, t.unit)}`}</span>
          </div>
        </div>`;
    }).join("");

    // Trackers auto-poll on a schedule — no manual buttons. The only action is dismissing
    // an alert banner.
    list.querySelectorAll(".trk-btn.ack").forEach((b) =>
      ctx.tap(b, async () => { await post(`/api/trackers/${b.dataset.id}/ack`); this._refresh(el, ctx); }));
  },

  async _refresh(el, ctx) {
    try {
      const data = await ctx.api("/api/trackers");
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      this._render(el, ctx, data);
    } catch (e) { /* keep current */ }
  },

  unmount() { clearInterval(this._timer); },
};
