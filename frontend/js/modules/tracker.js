// Tracker: custom "watch this" routines — TUI holiday price, DVLA licence, and parcels.
// All auto-poll, so there are no manual buttons (only dismissing an alert). Parcels come
// from the user's Parcel.app account and share ONE card that cycles through them, rather
// than a card each.
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

// Parcel status -> colour: delivered green, a problem red, in-transit neutral.
const parcelCls = (v) => (v >= 3 ? "ok" : v < 0 ? "bad" : "");

export const tracker = {
  _timer: null, _parcelTimer: null, _parcels: [], _parcelIdx: 0, _el: null, _ctx: null,

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

  // Holiday (numeric) / DVLA (status) card.
  _cardHtml(t) {
    const al = t.alert && t.alert.active ? t.alert : null;
    const isStatus = t.status != null;
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
  },

  _render(el, ctx, data) {
    this._el = el; this._ctx = ctx;
    const list = el.querySelector("#trk-list");
    if (!list) return;
    const trackers = (data && data.trackers) || [];
    if (!trackers.length) {
      clearInterval(this._parcelTimer);
      list.innerHTML = `<div class="muted" style="padding:24px">No trackers configured.</div>`;
      return;
    }
    const parcels = trackers.filter((t) => t.id.startsWith("parcel:"));
    const others = trackers.filter((t) => !t.id.startsWith("parcel:"))
      .sort((a, b) => (a.id === "dvla" ? 1 : 0) - (b.id === "dvla" ? 1 : 0));   // DVLA last
    this._parcels = parcels;
    if (this._parcelIdx >= parcels.length) this._parcelIdx = 0;

    // Parcels first (one cycling card), then holiday, then DVLA.
    list.innerHTML = (parcels.length ? `<div class="trk-card" id="parcel-card"></div>` : "")
      + others.map((t) => this._cardHtml(t)).join("");

    clearInterval(this._parcelTimer);
    if (parcels.length) {
      this._renderParcel();
      if (parcels.length > 1) {
        this._parcelTimer = setInterval(() => {
          this._parcelIdx = (this._parcelIdx + 1) % this._parcels.length;
          this._renderParcel();
        }, 5000);
      }
    }
    this._bindAck(list);
  },

  // The single cycling parcel card, showing the current delivery in full.
  _renderParcel() {
    const el = this._el;
    const card = el && el.querySelector("#parcel-card");
    if (!card || !this._parcels.length) return;
    const n = this._parcels.length, i = this._parcelIdx % n;
    const p = this._parcels[i];
    const al = p.alert && p.alert.active ? p.alert : null;
    const dots = n > 1
      ? `<div class="parcel-dots">${this._parcels.map((_, k) =>
          `<i class="${k === i ? "on" : ""}"></i>`).join("")}</div>` : "";
    card.className = `trk-card${al ? " trk-alerting" : ""}`;
    card.innerHTML = `
      <div class="trk-top">
        <div>
          <div class="trk-label">📦 ${esc(p.label)}</div>
          <div class="trk-note">${esc(p.note || "")}</div>
        </div>
        ${n > 1 ? `<div class="parcel-count">${i + 1}/${n}</div>` : ""}
      </div>
      <div class="trk-statuswrap">
        <div class="trk-status ${parcelCls(p.value)}">${esc(p.status || "—")}</div>
        ${p.detail ? `<div class="trk-detail muted">${esc(p.detail)}</div>` : ""}
      </div>
      ${al ? `<div class="trk-banner change">Update → ${esc(al.to)}
          <button class="trk-btn ack" data-id="${esc(p.id)}">Dismiss</button></div>` : ""}
      ${dots}
      <div class="trk-foot"><span class="muted">updated ${ago(p.updated_at)}</span></div>`;
    this._bindAck(card);
  },

  _bindAck(root) {
    const ctx = this._ctx, el = this._el;
    root.querySelectorAll(".trk-btn.ack").forEach((b) =>
      ctx.tap(b, async () => { await post(`/api/trackers/${b.dataset.id}/ack`); this._refresh(el, ctx); }));
  },

  async _refresh(el, ctx) {
    try {
      const data = await ctx.api("/api/trackers");
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      this._render(el, ctx, data);
    } catch (e) { /* keep current */ }
  },

  unmount() { clearInterval(this._timer); clearInterval(this._parcelTimer); },
};
