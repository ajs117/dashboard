// Home: clock, weather, news+facts panel, world-clock carousel, stocks ticker, app carousel.
import { esc } from "../util.js";

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
  { route: "tracker", ico: "📈", label: "Tracker" },
];

// Bundled trivia (offline-friendly; rotated alongside live news headlines).
const FACTS = [
  "Honey never spoils — edible pots have been found in 3,000-year-old tombs.",
  "Octopuses have three hearts and blue, copper-based blood.",
  "A day on Venus is longer than its year.",
  "Bananas are berries, but strawberries aren't.",
  "The Eiffel Tower can grow over 15 cm taller in summer heat.",
  "Wombats produce cube-shaped droppings.",
  "Sharks predate trees by about 50 million years.",
  "A bolt of lightning is roughly five times hotter than the Sun's surface.",
  "Scotland's national animal is the unicorn.",
  "There are more possible chess games than atoms in the observable universe.",
  "Hot water can freeze faster than cold water (the Mpemba effect).",
  "A group of flamingos is called a flamboyance.",
  "The shortest war in history lasted about 38 minutes.",
  "Humans share roughly 60% of their DNA with bananas.",
  "Sea otters hold hands while sleeping so they don't drift apart.",
  "The Great Wall of China isn't visible from space with the naked eye.",
  "Cows have best friends and get stressed when separated.",
  "Venus is the only planet that spins clockwise.",
  "A teaspoon of neutron star would weigh about a billion tonnes.",
  "Pineapples take about two years to grow.",
  "The dot over a lowercase 'i' or 'j' is called a tittle.",
  "Sloths can hold their breath longer than dolphins can.",
  "Norway once knighted a penguin.",
  "An octopus can taste with its arms.",
  "The inventor of the frisbee was turned into a frisbee after he died.",
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
  _tkRAF: null, _tkOff: 0, _carKey: null,
  _feed: [], _feedIdx: 0, _feedTimer: null, _newsTimer: null, _factsTimer: null,
  _trkTimer: null, _news: [], _facts: [],

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    const localTz = cfg.location?.timezone || undefined;
    this._clocks = cfg.world_clocks || [];
    this._carIdx = 0;
    this._carKey = null;
    this._feed = [];
    this._feedIdx = 0;

    el.innerHTML = `
      <div class="module home">
        <div class="clock-card">
          <div class="big-time" id="big-time">--:--:--</div>
          <div class="big-date" id="big-date"></div>
        </div>

        <div class="news-card" id="news"><span class="muted">Loading news…</span></div>

        <div class="app-carousel">
          <button class="car-arrow" id="apps-prev" aria-label="previous">‹</button>
          <div class="car-track" id="apps-track">
            ${APPS.map((a) => `
              <button class="app-tile" data-route="${a.route}">
                <span class="ico">${a.ico}</span><span class="lbl">${a.label}</span>
                <span class="tile-badge" hidden>!</span>
              </button>`).join("")}
          </div>
          <button class="car-arrow" id="apps-next" aria-label="next">›</button>
        </div>

        <div class="weather-card" id="wx"><div class="muted">Loading weather…</div></div>

        <div class="carousel-card"><div class="carousel" id="carousel"></div></div>

        <div class="ticker-bar"><div class="ticker" id="ticker">
          <span class="muted">Loading markets…</span></div></div>
      </div>`;

    // App carousel: tiles use a movement-thresholded tap so swiping scrolls and a tap opens.
    el.querySelectorAll(".app-tile").forEach((b) =>
      ctx.tapRow(b, () => ctx.go(b.dataset.route)));
    const track = el.querySelector("#apps-track");
    ctx.tap(el.querySelector("#apps-prev"),
      () => track.scrollBy({ left: -track.clientWidth * 0.7, behavior: "smooth" }));
    ctx.tap(el.querySelector("#apps-next"),
      () => track.scrollBy({ left: track.clientWidth * 0.7, behavior: "smooth" }));

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

    // --- News + facts feed (BBC UK+World mix + facts API; bundled facts = offline fallback) ---
    this._news = [];
    this._facts = [...FACTS].sort(() => Math.random() - 0.5);  // fallback until the API responds
    this._rebuildFeed();
    this._renderFeed(el);
    this._feedTimer = setInterval(() => {
      this._feedIdx = (this._feedIdx + 1) % Math.max(1, this._feed.length);
      this._renderFeed(el);
    }, 9000);
    const loadNews = async () => {
      try {
        const env = await ctx.api("/api/news");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        this._news = ((env.data && env.data.headlines) || []).map((h) => h.title);
        this._rebuildFeed();
      } catch (e) { /* keep current feed */ }
    };
    const loadFacts = async () => {
      try {
        const env = await ctx.api("/api/facts");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const f = (env.data && env.data.facts) || [];
        if (f.length) { this._facts = f; this._rebuildFeed(); }  // else keep bundled fallback
      } catch (e) { /* keep bundled fallback */ }
    };
    await Promise.all([loadNews(), loadFacts()]);
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    this._newsTimer = setInterval(loadNews, 900000);    // 15 min
    this._factsTimer = setInterval(loadFacts, 3600000); // 1 h

    // --- Tracker alert badge on the Tracker tile ---
    const loadTrackers = async () => {
      try {
        const data = await ctx.api("/api/trackers");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const tile = el.querySelector('.app-tile[data-route="tracker"] .tile-badge');
        if (tile) tile.hidden = !(data && data.alert);
      } catch (e) { /* ignore */ }
    };
    await loadTrackers();
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    this._trkTimer = setInterval(loadTrackers, 60000);

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
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
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
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    this._stkTimer = setInterval(loadStocks, (cfg.refresh?.stocks || 300) * 1000);
    this._startTicker(el);
  },

  _rebuildFeed() {
    // Interleave news, fact, news, fact … so headlines lead but facts still appear.
    const news = (this._news || []).map((t) => ({ kind: "news", text: t }));
    const facts = (this._facts || []).map((t) => ({ kind: "fact", text: t }));
    const merged = [];
    const n = Math.max(news.length, facts.length);
    for (let i = 0; i < n; i++) {
      if (i < news.length) merged.push(news[i]);
      if (i < facts.length) merged.push(facts[i]);
    }
    this._feed = merged.length ? merged : facts;
    if (this._feedIdx >= this._feed.length) this._feedIdx = 0;
  },

  _renderFeed(el) {
    const box = el.querySelector("#news");
    if (!box || !this._feed.length) return;
    const item = this._feed[this._feedIdx % this._feed.length];
    const isNews = item.kind === "news";
    box.innerHTML = `
      <div class="news-tag ${isNews ? "news" : "fact"}">${isNews ? "📰 BBC News" : "💡 Did you know"}</div>
      <div class="news-text">${esc(item.text)}</div>`;
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
      // Wrap on exactly one sequence's width (not scrollWidth/2, which the optional
      // "delayed" badge would throw off and cause a visible jump).
      const seqEl = tk.querySelector(".tk-seq");
      const span = seqEl ? seqEl.offsetWidth : (tk.scrollWidth / 2);
      const wrap = span || 1;
      this._tkOff -= speed * dt;
      if (this._tkOff <= -wrap) this._tkOff += wrap;
      tk.style.transform = `translateX(${this._tkOff}px)`;
      this._tkRAF = requestAnimationFrame(step);
    };
    this._tkRAF = requestAnimationFrame(step);
  },

  _renderCarousel(el) {
    if (!this._clocks.length) return;
    const now = new Date();
    // The clock tick calls this every second, but the cards only change when the
    // visible set rotates or the minute rolls over — skip the rebuild otherwise.
    const key = this._carIdx + ":" + now.getHours() + ":" + now.getMinutes();
    if (key === this._carKey) return;
    this._carKey = key;
    const car = el.querySelector("#carousel");
    if (!car) return;
    const n = this._clocks.length;
    const visible = Math.min(3, n);
    let html = "";
    for (let k = 0; k < visible; k++) {
      const c = this._clocks[(this._carIdx + k) % n];
      html += `
        <div class="wc">
          <div class="city">${esc(c.label)} <span class="tz">${esc(tzAbbr(now, c.tz))}</span></div>
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
    clearInterval(this._feedTimer);
    clearInterval(this._newsTimer);
    clearInterval(this._factsTimer);
    clearInterval(this._trkTimer);
    cancelAnimationFrame(this._tkRAF);
  },
};

function renderWeather(el, w) {
  if (!w) { el.innerHTML = `<div class="err">Weather unavailable</div>`; return; }
  const c = w.current || {};
  const unit = w.units?.temperature || "°";
  const windUnit = esc(w.units?.wind || "");
  const emoji = WMO_EMOJI[c.code] ?? "•";
  const moon = w.moon || {};
  const moonIco = MOON_EMOJI[moon.index] ?? "🌙";
  const days = (w.daily || []).slice(1, 5);
  const t = (x) => (x == null || Number.isNaN(x) ? "—" : Math.round(x) + unit);
  const gust = c.wind_gust != null ? ` (gust ${Math.round(c.wind_gust)})` : "";

  el.innerHTML = `
    <div class="wx-now">
      <div style="font-size:60px">${emoji}</div>
      <div>
        <div class="wx-temp">${t(c.temperature)}</div>
        <div class="wx-text">${esc(c.text || "")} · ${esc(w.label || "")}</div>
        <div class="wx-sub">Feels ${t(c.apparent)}</div>
      </div>
    </div>
    <div class="wx-stats">
      <div class="item"><span class="k">Dew point</span><span class="v">${t(c.dew_point)}</span></div>
      <div class="item"><span class="k">Humidity</span><span class="v">${c.humidity != null ? Math.round(c.humidity) + "%" : "—"}</span></div>
      <div class="item" style="flex:1.7"><span class="k">Wind</span><span class="v">${c.wind_speed != null ? Math.round(c.wind_speed) : "—"} ${windUnit} ${esc(c.wind_compass || "")}${gust}</span></div>
    </div>
    <div class="wx-astro">
      <div class="item">🌅 ${fmtClock(w.sun?.sunrise)}</div>
      <div class="item">🌇 ${fmtClock(w.sun?.sunset)}</div>
      <div class="item">${moonIco} ${esc(moon.name || "")} ${Math.round((moon.illumination || 0) * 100)}%</div>
    </div>
    <div class="wx-forecast">
      ${days.map((d) => `
        <div class="wx-day">
          <div class="d">${esc(dayName(d.date))}</div>
          <div style="font-size:22px">${forecastIcon(d.code, d.precip_prob)}</div>
          <div class="hi">${d.tmax != null ? Math.round(d.tmax) + "°" : "—"}</div>
          <div class="muted">${d.tmin != null ? Math.round(d.tmin) + "°" : "—"}</div>
          ${d.precip_prob != null ? `<div class="muted">💧${d.precip_prob}%</div>` : ""}
        </div>`).join("")}
    </div>`;
}

function renderTicker(el, data, stale) {
  const quotes = ((data && data.quotes) || []).filter((q) => q.ok);
  if (!quotes.length) { el.innerHTML = `<span class="muted">Markets unavailable</span>`; return; }
  const item = (q) => {
    const up = (q.pct ?? 0) >= 0;
    const arrow = up ? "▲" : "▼";
    return `<span class="tk">
      <span class="nm">${esc(q.label)}</span>
      <span class="px">${q.price != null ? q.price.toLocaleString() : "—"}</span>
      <span class="${up ? "up" : "down"}">${arrow} ${Math.abs(q.pct ?? 0).toFixed(2)}%</span>
    </span>`;
  };
  // Two identical sequences so the marquee loops seamlessly; the rAF wraps on one
  // sequence's measured width (.tk-seq), so the optional "delayed" badge doesn't skew it.
  const seq = quotes.map(item).join("");
  el.innerHTML = `<span class="tk-seq">${seq}</span><span class="tk-seq">${seq}</span>`
    + (stale ? `<span class="tk muted">delayed</span>` : "");
}
