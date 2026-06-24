// Tracker: custom "watch this" routines. First one is the TUI holiday price.
// Manual price entry via an on-screen keypad (the panel is a touch kiosk, no keyboard).
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
  _timer: null, _entry: null,   // _entry: id currently being edited (keypad open)

  async mount(el, ctx) {
    this._entry = null;
    el.innerHTML = `<div class="tracker"><div class="trk-list" id="trk-list">
      <div class="muted" style="padding:24px">Loading trackers…</div></div>
      <div class="keypad-wrap" id="keypad" hidden></div></div>`;

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
    if (this._entry) return;                  // don't redraw under an open keypad
    const list = el.querySelector("#trk-list");
    if (!list) return;
    const trackers = (data && data.trackers) || [];
    if (!trackers.length) {
      list.innerHTML = `<div class="muted" style="padding:24px">No trackers configured.</div>`;
      return;
    }
    list.innerHTML = trackers.map((t) => {
      const al = t.alert && t.alert.active ? t.alert : null;
      const isStatus = t.status != null;              // DVLA-style status tracker
      let valueCell, body, banner, footBtn;
      if (isStatus) {
        valueCell = `<div class="trk-statuswrap">
            <div class="trk-status ${t.value === 0 ? "bad" : "ok"}">${esc(t.status)}</div>
            ${t.detail ? `<div class="trk-detail muted">${esc(t.detail)}</div>` : ""}</div>`;
        body = "";
        banner = al ? `<div class="trk-banner change">
            Status changed → ${esc(al.to)}
            <button class="trk-btn ack" data-id="${esc(t.id)}">Dismiss</button></div>` : "";
        footBtn = `<button class="trk-btn check" data-id="${esc(t.id)}">Check now</button>`;
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
        footBtn = `<button class="trk-btn update" data-id="${esc(t.id)}" data-unit="${esc(t.unit)}">Update price</button>`;
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
            ${footBtn}
          </div>
        </div>`;
    }).join("");

    list.querySelectorAll(".trk-btn.update").forEach((b) =>
      ctx.tap(b, () => this._openKeypad(el, ctx, b.dataset.id, b.dataset.unit)));
    list.querySelectorAll(".trk-btn.ack").forEach((b) =>
      ctx.tap(b, async () => { await post(`/api/trackers/${b.dataset.id}/ack`); this._refresh(el, ctx); }));
    list.querySelectorAll(".trk-btn.check").forEach((b) =>
      ctx.tap(b, async () => {
        b.textContent = "Checking…";
        try { await post(`/api/trackers/${b.dataset.id}/refresh`); } catch (e) { /* ignore */ }
        this._refresh(el, ctx);
      }));
  },

  _openKeypad(el, ctx, id, unit) {
    this._entry = id;
    let buf = "";
    const kp = el.querySelector("#keypad");
    const draw = () => {
      kp.querySelector(".kp-display").textContent = (unit || "") + (buf || "0");
    };
    kp.hidden = false;
    kp.innerHTML = `
      <div class="keypad">
        <div class="kp-title">New price for update</div>
        <div class="kp-display">${esc(unit || "")}0</div>
        <div class="kp-grid">
          ${["1","2","3","4","5","6","7","8","9",".","0","⌫"].map((k) =>
            `<button class="kp-key" data-k="${k}">${k}</button>`).join("")}
        </div>
        <div class="kp-actions">
          <button class="kp-cancel">Cancel</button>
          <button class="kp-save">Save</button>
        </div>
      </div>`;
    kp.querySelectorAll(".kp-key").forEach((b) =>
      ctx.tap(b, () => {
        const k = b.dataset.k;
        if (k === "⌫") buf = buf.slice(0, -1);
        else if (k === "." ) { if (!buf.includes(".")) buf += "."; }
        else if (buf.replace(".", "").length < 9) buf += k;
        draw();
      }));
    ctx.tap(kp, (e) => { if (e.target === kp) this._closeKeypad(el, ctx); });  // tap backdrop to close
    ctx.tap(kp.querySelector(".kp-cancel"), () => this._closeKeypad(el, ctx));
    ctx.tap(kp.querySelector(".kp-save"), async () => {
      const val = parseFloat(buf);
      if (!Number.isNaN(val)) {
        try { await post(`/api/trackers/${id}/value`, { value: val }); } catch (e) { /* ignore */ }
      }
      this._closeKeypad(el, ctx);
    });
  },

  _closeKeypad(el, ctx) {
    this._entry = null;
    const kp = el.querySelector("#keypad");
    if (kp) { kp.hidden = true; kp.innerHTML = ""; }
    this._refresh(el, ctx);
  },

  async _refresh(el, ctx) {
    try {
      const data = await ctx.api("/api/trackers");
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      this._render(el, ctx, data);
    } catch (e) { /* keep current */ }
  },

  unmount() { clearInterval(this._timer); this._entry = null; },
};
