// Home: clock, weather, news+facts panel, world-clock carousel, stocks ticker, app carousel.
import { esc } from "../util.js";
import { radarNowcast } from "./rainNowcast.js";

const WMO_EMOJI = {
  // NB: avoid Miscellaneous-Symbols emoji (☀️ ☁️ ❄️ ⛈️) — their Unicode default is
  // *text* presentation, and WPE/WebKit ignores the VS16 selector, so they render as a
  // monochrome (white-on-dark) glyph. The supplementary-block (U+1F3xx) emoji default to
  // emoji presentation and render in colour, so use those throughout.
  0: "🌞", 1: "🌤️", 2: "⛅", 3: "🌥️", 45: "🌫️", 48: "🌫️",
  51: "🌦️", 53: "🌦️", 55: "🌧️", 61: "🌦️", 63: "🌧️", 65: "🌧️",
  71: "🌨️", 73: "🌨️", 75: "🌨️", 80: "🌦️", 81: "🌧️", 82: "🌧️",
  95: "🌩️", 96: "🌩️", 99: "🌩️",
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
  _trkTimer: null, _indoorTimer: null, _news: [], _facts: [], _sensor: null,
  _air: null, _airTimer: null, _wx: null, _wxPage: 0, _homeTimer: null, _sec: 0,
  _cdIdx: 0, _cdDay: null, _appTimer: null, _parcelSubs: [], _parcelSubIdx: 0,

  async mount(el, ctx) {
    const cfg = ctx.config || {};
    const localTz = cfg.location?.timezone || undefined;
    this._clocks = cfg.world_clocks || [];
    this._carIdx = 0;
    this._carKey = null;
    this._feed = [];
    this._feedIdx = 0;
    this._sensor = null;   // don't carry a previous mount's reading into a fresh card
    this._air = null;
    this._wx = null;
    this._wxPage = 0;
    this._sec = 0;
    this._cdIdx = 0;
    this._cdDay = null;

    el.innerHTML = `
      <div class="module home">
        <div class="clock-card">
          <div class="clock-main">
            <div class="big-time" id="big-time">--:--:--</div>
            <div class="big-date" id="big-date"></div>
          </div>
          <div class="hs-tile wc-mini" id="carousel"></div>
        </div>

        <div class="news-card" id="news"><span class="muted">Loading news…</span></div>

        <div class="app-carousel">
          <button class="car-arrow" id="apps-prev" aria-label="previous">‹</button>
          <div class="car-track" id="apps-track">
            ${APPS.map((a) => `
              <button class="app-tile" data-route="${a.route}">
                <span class="ico">${a.ico}</span><span class="lbl">${a.label}</span>
                <span class="tile-sub" data-route="${a.route}"></span>
                <span class="tile-badge" hidden>!</span>
              </button>`).join("")}
          </div>
          <button class="car-arrow" id="apps-next" aria-label="next">›</button>
        </div>

        <div class="weather-card" id="wx"><div class="muted">Loading weather…</div></div>

        <div class="home-strip">
          <div class="hs-tile" id="countdown"><div class="hs-k">⏳ Countdown</div><div class="hs-v">—</div></div>
          <div class="hs-tile" id="home-indoor"><div class="hs-k">🏠 Indoor</div><div class="hs-v">—</div></div>
          <div class="hs-tile" id="home-solar"><div class="hs-k">🌞 Solar</div><div class="hs-v">—</div></div>
        </div>

        <div class="ticker-bar"><div class="ticker" id="ticker">
          <span class="muted">Loading markets…</span></div></div>
      </div>`;

    // Launch on first contact (pointerdown): the cheap panel reports an accurate press
    // coordinate but often jumps on release, so firing on release lands on the wrong tile.
    // Tiles all fit on screen now, so we don't need release-based scroll detection.
    el.querySelectorAll(".app-tile").forEach((b) =>
      ctx.tap(b, () => ctx.go(b.dataset.route)));
    const track = el.querySelector("#apps-track");
    const prevA = el.querySelector("#apps-prev"), nextA = el.querySelector("#apps-next");
    ctx.tap(prevA, () => track.scrollBy({ left: -track.clientWidth * 0.7, behavior: "smooth" }));
    ctx.tap(nextA, () => track.scrollBy({ left: track.clientWidth * 0.7, behavior: "smooth" }));
    // Only show the paging arrows if the tiles actually overflow (with 4 they fit, so
    // every app is reachable with a single tap — no scrolling on the iffy touch panel).
    requestAnimationFrame(() => {
      const overflow = track.scrollWidth > track.clientWidth + 4;
      prevA.hidden = nextA.hidden = !overflow;
    });

    const bigTime = el.querySelector("#big-time");
    const bigDate = el.querySelector("#big-date");
    // One 1-second tick drives the clock and both carousels, so their motion is staggered
    // and calm: the world clock rotates every 10s (at :00), the weather page every 10s but
    // offset by 5s (at :05) — only one thing ever changes at a time, each with a fade.
    const tick = () => {
      const now = new Date();
      bigTime.textContent = fmt(now, { hour: "2-digit", minute: "2-digit",
        second: "2-digit", hour12: false }, localTz);
      bigDate.textContent = fmt(now, { weekday: "long", day: "numeric",
        month: "long", year: "numeric" }, localTz);
      this._sec += 1;
      if (this._sec % 10 === 0) {
        this._carIdx = (this._carIdx + 1) % Math.max(1, this._clocks.length);
      }
      if (this._sec % 10 === 5 && this._wx) {
        this._wxPage = (this._wxPage + 1) % 4;   // stats / sun-moon / air / 5-day forecast
        renderWxCycle();
      }
      // Cycle one parcel summary at a time on the Tracker tile (every 5s).
      if (this._sec % 5 === 0 && this._parcelSubs.length > 1) {
        this._parcelSubIdx = (this._parcelSubIdx + 1) % this._parcelSubs.length;
        const s = el.querySelector('.tile-sub[data-route="tracker"]');
        if (s) s.textContent = this._parcelSubs[this._parcelSubIdx];
      }
      this._renderCarousel(el);
      // Countdown tile: render on first tick + at midnight (day change); cycle if several.
      const cds = cfg.countdowns || [];
      if (this._sec % 10 === 0 && cds.length > 1) {
        this._cdIdx = (this._cdIdx + 1) % cds.length;
        renderCountdown(el, cds, this._cdIdx);
      }
      const dayKey = now.toDateString();
      if (dayKey !== this._cdDay) {
        this._cdDay = dayKey;
        renderCountdown(el, cds, this._cdIdx);
      }
    };
    tick();
    this._timer = setInterval(tick, 1000);   // drives clock + both staggered carousels

    // --- News + facts feed (BBC UK+World mix + facts API; bundled facts = offline fallback) ---
    this._news = [];
    this._facts = [...FACTS].sort(() => Math.random() - 0.5);  // fallback until the API responds
    this._rebuildFeed();
    this._renderFeed(el);
    this._feedTimer = setInterval(() => {
      this._feedIdx = (this._feedIdx + 1) % Math.max(1, this._feed.length);
      this._renderFeed(el);
    }, 25000);   // calmer rotation so it doesn't burn through items
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

    // --- App-tile live summaries: parcels (cycling), trains, aircraft, rain ---
    const setSub = (route, text) => {
      const s = el.querySelector(`.tile-sub[data-route="${route}"]`);
      if (s) s.textContent = text || "";
    };
    const loadTrackers = async () => {
      try {
        const data = await ctx.api("/api/trackers");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const tile = el.querySelector('.app-tile[data-route="tracker"] .tile-badge');
        if (tile) tile.hidden = !(data && data.alert);
        this._parcelSubs = parcelSubs((data && data.trackers) || []);   // cycled in tick()
        if (this._parcelSubIdx >= this._parcelSubs.length) this._parcelSubIdx = 0;
        setSub("tracker", this._parcelSubs[this._parcelSubIdx] || "No parcels");
      } catch (e) { /* ignore */ }
    };
    const loadAppInfo = async () => {
      try { const d = await ctx.api("/api/trains"); setSub("trains", trainsSub(d.data)); } catch (e) { /* ignore */ }
      try { const d = await ctx.api("/api/aircraft"); setSub("aircraft", aircraftSub(d.data)); } catch (e) { /* ignore */ }
      try {
        const env = await ctx.api("/api/radar");            // real radar sampled at our point
        let fc = null;
        try { fc = await radarNowcast(env.data, cfg.location?.lat, cfg.location?.lon); } catch (e) { /* fall back */ }
        if (!fc) { try { fc = (await ctx.api("/api/radar/forecast")).data; } catch (e) { /* ignore */ } }
        setSub("radar", radarSub(fc));
      } catch (e) { /* ignore */ }
    };
    await Promise.all([loadTrackers(), loadAppInfo()]);
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    this._trkTimer = setInterval(loadTrackers, 60000);
    this._appTimer = setInterval(loadAppInfo, 120000);

    // Govee sensor = the ACTUAL measured temp at your location; overrides the headline
    // temperature (Open-Meteo is only an estimate), tagged "live". Its humidity + dew show
    // on the stats page of the cycling row (rebuilt by renderWxCycle from _sensor).
    const applySensor = () => {
      const s = this._sensor;
      if (!s || !s.enabled) return;
      const useF = (cfg.units?.temperature === "fahrenheit");
      const t = useF ? s.temperature_f : s.temperature_c;
      const haveT = t != null, haveH = s.humidity != null;
      if (!haveT && !haveH && s.online !== false) return;
      const tEl = el.querySelector("#wx-temp");
      const mEl = el.querySelector("#wx-live");
      if (tEl && haveT) tEl.textContent = t.toFixed(1) + (useF ? "°F" : "°C");
      if (mEl) {
        const offline = s.online === false;
        mEl.textContent = offline ? "● offline" : (haveT || haveH ? "● live" : "");
        mEl.classList.toggle("offline", offline);   // grey, not the green "live" colour
      }
    };

    // The weather detail row cycles through 3 pages (stats / sun-moon / air); this rebuilds
    // the visible page from the stored weather + air + sensor data and lights the dot.
    const renderWxCycle = () => {
      const box = el.querySelector("#wx-cycle");
      if (!box || !this._wx) return;
      box.innerHTML = wxCycleHtml(this._wxPage, this._wx, this._air, this._sensor);
      el.querySelectorAll("#wx-dots i").forEach((d, i) => d.classList.toggle("on", i === this._wxPage));
    };

    const loadSensor = async () => {
      try {
        const env = await ctx.api("/api/sensor");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        this._sensor = env.data;
        applySensor();
        renderWxCycle();                      // live humidity/dew sit on the stats page
      } catch (e) { /* keep the model values */ }
    };
    const loadAir = async () => {
      try {
        const env = await ctx.api("/api/air");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        this._air = env.data;
        renderWxCycle();                      // refresh the air page if it's showing
      } catch (e) { /* leave the air page empty */ }
    };

    const loadWeather = async () => {
      try {
        const env = await ctx.api("/api/weather");
        if (ctx.isCurrent && !ctx.isCurrent()) return;
        const wx = el.querySelector("#wx");
        if (!wx) return;
        ctx.setStale(env.stale, "weather");
        this._wx = env.data;
        renderWeather(wx, env.data);
        renderWxCycle();                      // fill the cycle row from stored data
        applySensor();                        // re-apply the live headline temp
      } catch (e) {
        const wx = el.querySelector("#wx");
        if (wx) wx.innerHTML = `<div class="err">Weather unavailable</div>`;
      }
    };

    // Home strip: Indoor (Hive) + Solar (EcoFlow). Both show "—" until configured.
    const loadHome = async () => {
      const [solar, indoor] = await Promise.all([
        ctx.api("/api/solar").catch(() => null),
        ctx.api("/api/indoor").catch(() => null),
      ]);
      if (ctx.isCurrent && !ctx.isCurrent()) return;
      renderHomeStrip(el, cfg, solar && solar.data, indoor && indoor.data);
    };

    await loadWeather();
    if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away during first fetch
    this._wxTimer = setInterval(loadWeather, (cfg.refresh?.weather || 600) * 1000);
    loadAir();
    this._airTimer = setInterval(loadAir, (cfg.cache?.air || 1800) * 1000);
    await loadSensor();
    if (ctx.isCurrent && !ctx.isCurrent()) return;
    this._indoorTimer = setInterval(loadSensor, (cfg.refresh?.indoor || 60) * 1000);
    loadHome();
    this._homeTimer = setInterval(loadHome, (cfg.cache?.solar || 60) * 1000);

    const loadStocks = async () => {
      try {
        const env = await ctx.api("/api/stocks");
        if (ctx.isCurrent && !ctx.isCurrent()) return;   // navigated away mid-fetch
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

  // World clock collapsed to a single cycling tile: shows one city, rotating via _carTimer.
  _renderCarousel(el) {
    if (!this._clocks.length) return;
    const now = new Date();
    // The clock tick calls this every second, but the tile only changes when the rotation
    // advances or the minute rolls over — skip the rebuild otherwise.
    const key = this._carIdx + ":" + now.getHours() + ":" + now.getMinutes();
    if (key === this._carKey) return;
    this._carKey = key;
    const car = el.querySelector("#carousel");
    if (!car) return;
    const c = this._clocks[this._carIdx % this._clocks.length];
    car.innerHTML = `
      <div class="hs-k">🌍 ${esc(c.label)} <span class="tz">${esc(tzAbbr(now, c.tz))}</span></div>
      <div class="hs-v">${fmt(now, { hour: "2-digit", minute: "2-digit", hour12: false }, c.tz)}</div>
      <div class="hs-s">${fmt(now, { weekday: "short", day: "numeric", month: "short" }, c.tz)}</div>`;
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
    clearInterval(this._appTimer);
    clearInterval(this._indoorTimer);
    clearInterval(this._airTimer);
    clearInterval(this._homeTimer);
    cancelAnimationFrame(this._tkRAF);
  },
};

// --- App-tile summary builders (one concise line under each app label) ---------------
function parcelSubs(trackers) {
  return (trackers || []).filter((t) => t.id && t.id.startsWith("parcel:")).map((p) => {
    const lbl = (p.label || "").replace(/^\d+\s+\w+,\s*/, "").slice(0, 18);  // drop leading "29 Jun, "
    return `${p.status}${lbl ? " · " + lbl : ""}`;
  });
}
function trainsSub(d) {
  const svc = (d && d.services) || [];
  if (!svc.length) return "No departures";
  const cancelled = svc.filter((s) => s.cancelled).length;
  const late = svc.filter((s) => !s.cancelled && s.etd && s.etd.toLowerCase() !== "on time").length;
  if (cancelled) return `⚠ ${cancelled} cancelled`;
  if (late) return `${late} delayed`;
  return "All on time";
}
function aircraftSub(d) {
  const a = ((d && d.aircraft) || [])[0];        // backend returns nearest-first
  if (!a) return "None nearby";
  const cs = (a.callsign || a.hex || "?").trim();
  return a.distance_mi != null ? `${cs} · ${a.distance_mi} mi` : cs;
}
function radarSub(fc) {
  if (!fc) return "";
  if (fc.raining_now) {
    const lvl = fc.level && fc.level !== "none" ? " " + fc.level : "";
    return `Raining${lvl}` + (fc.minutes_until_stop != null ? ` · ~${fc.minutes_until_stop}m` : "");
  }
  if (fc.status === "starting" && fc.minutes_until_start != null) return `Rain in ~${fc.minutes_until_start}m`;
  return "Dry";
}

// Severity -> colour class, shared by the air pills (module scope so wxCycleHtml can use it).
const LVL = {
  "Good": "lvl-good", "Low": "lvl-good", "Fair": "lvl-ok", "Moderate": "lvl-mod",
  "Poor": "lvl-high", "High": "lvl-high", "Very poor": "lvl-bad", "Very high": "lvl-bad",
  "Extreme": "lvl-bad", "Extremely poor": "lvl-bad",
};
const lvlClass = (band) => LVL[band] || "";

// The weather card's detail rows are collapsed into one row that cycles through 3 pages
// (stats / sun-moon / air), like the world clock. This builds one page's three pills.
// The Govee live reading (sensor) overrides humidity + dew on the stats page.
function wxCycleHtml(page, w, air, sensor) {
  const c = (w && w.current) || {};
  const unit = w?.units?.temperature || "°";
  const useF = unit.includes("F");
  // Every pill is the same shape — a centred label over a centred value — so the row reads
  // consistently as the pages cycle (no jumping). `value` may contain a coloured band span.
  const pill = (label, value, title = "") =>
    `<div class="item"${title ? ` title="${esc(title)}"` : ""}>`
    + `<div class="ck">${label}</div><div class="cv">${value}</div></div>`;
  const band = (b) => {
    const SHORT = { "Moderate": "Mod", "Very poor": "V.poor", "Extremely poor": "E.poor",
      "Very high": "V.high", "Extreme": "Extr" };
    return b ? ` <span class="cb ${lvlClass(b)}">${esc(SHORT[b] || b)}</span>` : "";
  };
  if (page === 3) return forecastPage(w);             // 5-day forecast (Today + next 4)
  if (page === 1) {                                   // sun / sunset / moon
    const moon = w?.moon || {};
    const moonIco = MOON_EMOJI[moon.index] ?? "🌙";
    return pill("🌅 Sunrise", fmtClock(w?.sun?.sunrise))
      + pill("🌇 Sunset", fmtClock(w?.sun?.sunset))
      + pill(`${moonIco} Moon`, `${Math.round((moon.illumination || 0) * 100)}%`, moon.name || "");
  }
  if (page === 2) {                                   // air quality / UV / pollen
    const a = air || {};
    const v = (x) => (x == null || x === "" ? "—" : esc(String(x)));
    return pill("💨 Air", `${v(a.aqi?.value)}${band(a.aqi?.band)}`)
      + pill("🔆 UV", `${v(a.uv?.value)}${band(a.uv?.band)}`)
      + pill("🌿 Pollen", `${v(a.pollen?.type)}${band(a.pollen?.band)}`);
  }
  // page 0: dew point / humidity / wind — with the Govee live override.
  const live = sensor && sensor.enabled;
  const humid = live && sensor.humidity != null ? sensor.humidity + "%"
    : (c.humidity != null ? Math.round(c.humidity) + "%" : "—");
  const dpVal = live ? (useF ? sensor.dew_point_f : sensor.dew_point_c) : null;
  const dew = dpVal != null ? dpVal.toFixed(1) + unit
    : (c.dew_point != null ? Math.round(c.dew_point) + unit : "—");
  // Wind reads "10/18 SW" — speed/gust + compass (gust omitted when not reported).
  const spd = c.wind_speed != null ? Math.round(c.wind_speed) : "—";
  const wind = (c.wind_gust != null ? `${spd}/${Math.round(c.wind_gust)}` : `${spd}`)
    + ` ${esc(c.wind_compass || "")}`;
  return pill("Dew point", dew) + pill("Humidity", humid)
    + pill(`Wind ${esc(w?.units?.wind || "")}`, wind);
}

function renderWeather(el, w) {
  if (!w) { el.innerHTML = `<div class="err">Weather unavailable</div>`; return; }
  const c = w.current || {};
  const unit = w.units?.temperature || "°";
  const emoji = WMO_EMOJI[c.code] ?? "•";
  const t = (x) => (x == null || Number.isNaN(x) ? "—" : Math.round(x) + unit);

  // The 5-day forecast is now a page in the cycling row (see wxCycleHtml page 3), so it's
  // no longer permanently taking space; 4 dots for the 4 pages.
  el.innerHTML = `
    <div class="wx-now">
      <div style="font-size:50px">${emoji}</div>
      <div>
        <div class="wx-temprow"><div class="wx-temp" id="wx-temp">${t(c.temperature)}</div>
          <span class="wx-live" id="wx-live"></span></div>
        <div class="wx-text">${esc(c.text || "")} · ${esc(w.label || "")}</div>
        <div class="wx-sub">Feels ${t(c.apparent)}</div>
      </div>
    </div>
    <div class="wx-body">
      <div class="wx-cycle" id="wx-cycle"></div>
      <div class="wx-dots" id="wx-dots"><i></i><i></i><i></i><i></i></div>
    </div>`;
}

// The 5-day forecast page: Today + the next 4 days, each with its max/min.
function forecastPage(w) {
  const days = (w?.daily || []).slice(0, 5);
  return days.map((d, i) => `
    <div class="wx-day">
      <div class="d">${i === 0 ? "Today" : esc(dayName(d.date))}</div>
      <div class="ico">${forecastIcon(d.code, d.precip_prob)}</div>
      <div class="temps">
        <span class="hi">${d.tmax != null ? Math.round(d.tmax) + "°" : "—"}</span>
        <span class="lo">${d.tmin != null ? Math.round(d.tmin) + "°" : "—"}</span>
      </div>
      ${d.precip_prob != null ? `<div class="pp">💧${d.precip_prob}%</div>` : ""}
    </div>`).join("");
}

// Fill the Indoor (Hive) + Solar (EcoFlow) tiles. Both degrade to "—" until configured.
function renderHomeStrip(el, cfg, solar, indoor) {
  const useF = (cfg.units?.temperature === "fahrenheit");
  const ind = el.querySelector("#home-indoor");
  const sol = el.querySelector("#home-solar");
  if (ind) {
    let v = "—", sub = "add 2nd Govee";
    if (indoor && indoor.enabled) {
      const t = useF ? indoor.temperature_f : indoor.temperature_c;
      if (t != null) v = t.toFixed(1) + (useF ? "°F" : "°C");
      sub = indoor.humidity != null ? `${indoor.humidity}% humidity`
        : (indoor.online === false ? "sensor offline" : "");
    }
    ind.innerHTML = `<div class="hs-k">🏠 Indoor</div><div class="hs-v">${v}</div>`
      + `<div class="hs-s">${esc(sub)}</div>`;
  }
  if (sol) {
    let v = "—", sub = "set up EcoFlow";
    if (solar && solar.enabled) {
      const w = solar.watts_now;
      v = w == null ? "0 W" : (w >= 1000 ? (w / 1000).toFixed(2) + " kW" : Math.round(w) + " W");
      sub = solar.kwh_today != null ? `${solar.kwh_today.toFixed(1)} kWh today` : "now";
    }
    sol.innerHTML = `<div class="hs-k">🌞 Solar</div><div class="hs-v">${v}</div>`
      + `<div class="hs-s">${esc(sub)}</div>`;
  }
}

// Countdown tile: whole days until a dated event (cycles through several, like the clock).
function renderCountdown(el, list, idx) {
  const box = el.querySelector("#countdown");
  if (!box) return;
  if (!list || !list.length) {
    box.innerHTML = `<div class="hs-k">⏳ Countdown</div><div class="hs-v">—</div>`
      + `<div class="hs-s">add in config</div>`;
    return;
  }
  const c = list[idx % list.length];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const target = new Date(`${c.date}T00:00:00`);
  const ok = !Number.isNaN(target.getTime());
  const days = ok ? Math.round((target - today) / 86400000) : NaN;
  const when = ok ? target.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const val = !ok ? "—" : days > 0 ? days : days === 0 ? "Today" : "passed";
  box.innerHTML = `<div class="hs-k">${esc(c.emoji || "⏳")} ${esc(c.label || "")}</div>`
    + `<div class="hs-v">${val}</div>`
    + `<div class="hs-s">${days > 0 ? "days · " : ""}${esc(when)}</div>`;
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
