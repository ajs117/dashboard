// Home: clock, weather (dew point + wind), world-clock carousel, stocks ticker, launcher.

const WMO_EMOJI = {
  0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌧️", 61: "🌦️", 63: "🌧️", 65: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "❄️", 80: "🌦️", 81: "🌧️", 82: "🌧️",
  95: "⛈️", 96: "⛈️", 99: "⛈️",
};
const MOON_EMOJI = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const APPS = [
  { route: "aircraft", ico: "✈️", label: "Aircraft" },
  { route: "radar", ico: "🌧️", label: "Rain Radar" },
  { route: "trains", ico: "🚆", label: "Trains" },
];

const fmt = (date, opts, tz) =>
  new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: tz }).format(date);
const fmtClock = (iso) => (iso ? iso.slice(11, 16) : "—");
const dayName = (iso) => {
  try { return new Date(iso).toLocaleDateString("en-GB", { weekday: "short" }); }
  catch { return iso; }
};
// Open-Meteo's *daily* weather_code is the worst moment of the day, so a 2%-chance
// afternoon shower flips a sunny day to ⛈️. Downgrade wet icons when the day's
// precip probability is actually low.
function forecastIcon(code, pp) {
  if (pp == null || code < 51) return WMO_EMOJI[code] ?? "•";
  if (code >= 71 && code <= 86) return WMO_EMOJI[code] ?? "🌨️";  // keep snow as-is
  if (pp >= 60) return WMO_EMOJI[code] ?? "🌧️";
  if (pp >= 35) return "🌦️";
  return code >= 95 ? "🌤️" : "⛅";
}
function tzAbbr(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short", timeZone: tz })
      .formatToParts(date).find((x) => x.type === "timeZoneName");
    return p ? p.value : "";
  } catch { return ""; }
}

export const home = {
  _timer: null, _wxTimer: null, _stkTimer: null, _carTimer: null, _carIdx: 0,
  _tkRAF: null, _tkOff: 0,

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    const localTz = cfg.location?.timezone || undefined;
    this._clocks = cfg.world_clocks || [];

    el.innerHTML = `
      <div class="module home">
        <div class="clock-card">
          <div class="big-time" id="big-time">--:--:--</div>
          <div class="big-date" id="big-date"></div>
        </div>

        <div class="weather-card" id="wx"><div class="muted">Loading weather…</div></div>

        <div class="launcher">
          ${APPS.map((a) => `
            <button class="app-tile" data-route="${a.route}">
              <span class="ico">${a.ico}</span><span class="lbl">${a.label}</span>
            </button>`).join("")}
        </div>

        <div class="carousel-card"><div class="carousel" id="carousel"></div></div>

        <div class="ticker-bar"><div class="ticker" id="ticker">
          <span class="muted">Loading markets…</span></div></div>
      </div>`;

    el.querySelectorAll(".app-tile").forEach((b) =>
      ctx.tap(b, () => ctx.go(b.dataset.route)));

    const bigTime = el.querySelector("#big-time");
    const bigDate = el.querySelector("#big-date");
    const tick = () => {
      const now = new Date();
      bigTime.textContent = fmt(now, { hour: "2-digit", minute: "2-digit",
        second: "2-digit", hour12: false }, localTz);
      bigDate.textContent = fmt(now, { weekday: "long", day: "numeric",
        month: "long", year: "numeric" }, localTz);
      this._renderCarousel(el);
    };
    tick();
    this._timer = setInterval(tick, 1000);
    this._carTimer = setInterval(() => {
      this._carIdx = (this._carIdx + 1) % Math.max(1, this._clocks.length);
    }, 5000);

    const loadWeather = async () => {
      try {
        const env = await ctx.api("/api/weather");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const wx = el.querySelector("#wx");
        if (!wx) return;
        ctx.setStale(env.stale, "weather");
        renderWeather(wx, env.data);
      } catch (e) {
        const wx = el.querySelector("#wx");
        if (wx) wx.innerHTML = `<div class="err">Weather unavailable</div>`;
      }
    };
    await loadWeather();
    this._wxTimer = setInterval(loadWeather, (cfg.refresh?.weather || 600) * 1000);

    const loadStocks = async () => {
      try {
        const env = await ctx.api("/api/stocks");
        const tk = el.querySelector("#ticker");
        if (!tk) return;
        renderTicker(tk, env.data, env.stale);
      } catch (e) {
        const tk = el.querySelector("#ticker");
        if (tk) tk.innerHTML = `<span class="muted">Markets unavailable</span>`;
      }
    };
    await loadStocks();
    this._stkTimer = setInterval(loadStocks, (cfg.refresh?.stocks || 300) * 1000);
    this._startTicker(el);
  },

  // JS-driven marquee (CSS keyframe animation doesn't tick reliably under WPE/cog).
  _startTicker(el) {
    cancelAnimationFrame(this._tkRAF);
    this._tkOff = 0;
    let last = performance.now();
    const speed = 45;  // px/sec
    const step = (now) => {
      const tk = el.querySelector("#ticker");
      if (!tk) return;                       // view replaced -> stop
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const half = (tk.scrollWidth / 2) || 1;
      this._tkOff -= speed * dt;
      if (this._tkOff <= -half) this._tkOff += half;
      tk.style.transform = `translateX(${this._tkOff}px)`;
      this._tkRAF = requestAnimationFrame(step);
    };
    this._tkRAF = requestAnimationFrame(step);
  },

  _renderCarousel(el) {
    const car = el.querySelector("#carousel");
    if (!car || !this._clocks.length) return;
    const now = new Date();
    const n = this._clocks.length;
    const visible = Math.min(3, n);
    let html = "";
    for (let k = 0; k < visible; k++) {
      const c = this._clocks[(this._carIdx + k) % n];
      html += `
        <div class="wc">
          <div class="city">${c.label} <span class="tz">${tzAbbr(now, c.tz)}</span></div>
          <div class="t">${fmt(now, { hour: "2-digit", minute: "2-digit", hour12: false }, c.tz)}</div>
          <div class="d">${fmt(now, { weekday: "short", day: "numeric", month: "short" }, c.tz)}</div>
        </div>`;
    }
    car.innerHTML = html;
  },

  unmount() {
    clearInterval(this._timer);
    clearInterval(this._wxTimer);
    clearInterval(this._stkTimer);
    clearInterval(this._carTimer);
    cancelAnimationFrame(this._tkRAF);
  },
};

function renderWeather(el, w) {
  const c = w.current || {};
  const unit = w.units?.temperature || "°";
  const windUnit = w.units?.wind || "";
  const emoji = WMO_EMOJI[c.code] ?? "•";
  const moon = w.moon || {};
  const moonIco = MOON_EMOJI[moon.index] ?? "🌙";
  const days = (w.daily || []).slice(1, 5);
  const gust = c.wind_gust != null ? ` (gust ${Math.round(c.wind_gust)})` : "";

  el.innerHTML = `
    <div class="wx-now">
      <div style="font-size:60px">${emoji}</div>
      <div>
        <div class="wx-temp">${Math.round(c.temperature)}${unit}</div>
        <div class="wx-text">${c.text || ""} · ${w.label || ""}</div>
        <div class="wx-sub">Feels ${Math.round(c.apparent)}${unit}</div>
      </div>
    </div>
    <div class="wx-stats">
      <div class="item"><span class="k">Dew point</span><span class="v">${Math.round(c.dew_point)}${unit}</span></div>
      <div class="item"><span class="k">Humidity</span><span class="v">${c.humidity != null ? Math.round(c.humidity) + "%" : "—"}</span></div>
      <div class="item" style="flex:1.7"><span class="k">Wind</span><span class="v">${Math.round(c.wind_speed)} ${windUnit} ${c.wind_compass || ""}${gust}</span></div>
    </div>
    <div class="wx-astro">
      <div class="item">🌅 ${fmtClock(w.sun?.sunrise)}</div>
      <div class="item">🌇 ${fmtClock(w.sun?.sunset)}</div>
      <div class="item">${moonIco} ${moon.name || ""} ${Math.round((moon.illumination || 0) * 100)}%</div>
    </div>
    <div class="wx-forecast">
      ${days.map((d) => `
        <div class="wx-day">
          <div class="d">${dayName(d.date)}</div>
          <div style="font-size:22px">${forecastIcon(d.code, d.precip_prob)}</div>
          <div class="hi">${Math.round(d.tmax)}°</div>
          <div class="muted">${Math.round(d.tmin)}°</div>
          ${d.precip_prob != null ? `<div class="muted">💧${d.precip_prob}%</div>` : ""}
        </div>`).join("")}
    </div>`;
}

function renderTicker(el, data, stale) {
  const quotes = (data.quotes || []).filter((q) => q.ok);
  if (!quotes.length) { el.innerHTML = `<span class="muted">Markets unavailable</span>`; return; }
  const item = (q) => {
    const up = (q.pct ?? 0) >= 0;
    const arrow = up ? "▲" : "▼";
    return `<span class="tk">
      <span class="nm">${q.label}</span>
      <span class="px">${q.price?.toLocaleString()}</span>
      <span class="${up ? "up" : "down"}">${arrow} ${Math.abs(q.pct ?? 0).toFixed(2)}%</span>
    </span>`;
  };
  // Duplicate the sequence so the marquee loops seamlessly (-50% keyframe).
  const seq = quotes.map(item).join("");
  el.innerHTML = seq + seq + (stale ? `<span class="tk muted">delayed</span>` : "");
}
