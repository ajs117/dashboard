// Radar-based rain nowcast computed in the browser from RainViewer tiles.
//
// Why: the server panel uses Open-Meteo's point forecast, whose model badly under-reads
// real-time convective rain (it reported 0 mm while heavy rain was falling). The actual
// radar — the same tiles the map already shows — tells the truth. We sample the radar
// over the observer's location, estimate the cells' motion by correlating consecutive
// frames, then advect that field to predict when rain starts/stops at the point
// (line-of-sight: what's upwind now arrives here later).
//
// Runs client-side because the Pi Zero can't decode PNG tiles fast enough and the browser
// decodes them for free; RainViewer serves the tiles with CORS, so the canvas isn't
// tainted. Everything is best-effort: any failure returns null so radar.js falls back to
// the server panel.

const Z = 7;                 // RainViewer radar's native max zoom
const TILE = 256;
// Sample window half-size in px (~110 km at z7 per side). This must be big enough that an
// approaching front is IN VIEW for several frames - at RADIUS 40 the rain only entered the
// window in the last frame or two, so there was nothing for the correlator to track and it
// returned zero motion ("dry" with rain 40px upwind). At 90 the same front is visible for
// 5+ frames and its centroid marches measurably toward the centre.
const RADIUS = 90;
const SCHEME = "4/1_1";      // same colour scheme the map draws, so tiles are cache-shared
const MAX_FRAMES = 8;        // most recent frames to consider (~80 min of history)
const HORIZON = 12;          // prediction steps (× frame interval ≈ next 2 hours)

const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;
// Inverse of the above (global pixels -> lat/lon), so we can hand the map a real coordinate
// for "the echo that reaches you in an hour".
const x2lon = (x) => (x / TILE / 2 ** Z) * 360 - 180;
const y2lat = (y) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILE / 2 ** Z))) * 180) / Math.PI;

// RGBA -> rain intensity scalar in [0,1].
//
// Measured from real scheme-4 tiles (see the palette sampled off tilecache): rain echo is
// strictly BLUE-dominant for light..moderate — light cyan rgb(136,221,238) deepening to
// rgb(0,71,104) — then jumps to orange/yellow rgb(255,170,0)..rgb(255,238,0) for heavy.
//
// The previous (r-b) heuristic got this exactly backwards: r-b is NEGATIVE for every blue
// rain colour (-102..-224), so real rain scored 0 ("none"), while the tile's semi-
// transparent terrain/cloud wash - grey-brown pixels like rgba(108,104,93,36) where
// r≈g≈b - scored ~0.48 and registered as permanent "light rain". Result: missed the rain
// arriving, then claimed it was raining indefinitely.
//
// So: require a meaningful alpha AND an actual rain hue. Blue-dominant => light/moderate
// scaled by how deep the blue is; red/orange-dominant with a low blue => heavy.
function intensity(r, g, b, a) {
  if (a < 120) return 0;              // ignore the faint terrain wash entirely
  const blueLead = b - r;             // >0 for every real light/moderate rain colour
  if (blueLead > 25) {
    // Light cyan (b-r ~102) -> deep blue (b-r ~224+). Deeper/darker = heavier.
    const depth = Math.min(1, Math.max(0, (255 - g) / 200));   // g falls as rain intensifies
    return Math.min(0.62, 0.10 + depth * 0.52);
  }
  // Heavy end of the ramp: strong red/orange/yellow, little blue.
  if (r > 200 && b < 90) return Math.min(1, 0.68 + (255 - g) / 255 * 0.30);
  // KNOWN GAP: snow. RainViewer renders snow in a separate pink/purple/white palette that
  // falls between the two tests above, so it currently reads as 0 (no echo). Fixing that
  // needs colours MEASURED off real snow tiles - guessing at them is what broke this
  // function in the first place - so it's deliberately left until there's snow to sample.
  return 0;                           // grey/brown terrain, coastlines, labels -> not rain
}
const LIGHT = 0.06, MODERATE = 0.5, HEAVY = 0.66;   // bucket thresholds on the scalar
function levelOf(v) {
  if (v < LIGHT) return "none";
  if (v < MODERATE) return "light";
  if (v < HEAVY) return "moderate";
  return "heavy";
}

// Fetch the tile as a CORS blob and load it via a blob: URL. Blob-URL images are
// same-origin, so the canvas is never tainted — unlike reusing the map's tile <img>,
// which the browser may have cached without CORS (then getImageData throws).
async function loadImage(src) {
  try {
    const r = await fetch(src, { mode: "cors" });
    if (!r.ok) return null;
    const url = URL.createObjectURL(await r.blob());
    const img = await new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null);
      im.src = url;
    });
    URL.revokeObjectURL(url);
    return img;
  } catch (e) {
    return null;
  }
}

// Render the RADIUS-window around (gx,gy) global pixels for one frame into a Float32 grid
// of intensities. Returns null if no tile loaded (frame empty / network).
async function sampleField(host, path, gx, gy) {
  const x0 = Math.round(gx) - RADIUS, y0 = Math.round(gy) - RADIUS;
  const size = RADIUS * 2 + 1;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x0 + size) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y0 + size) / TILE);
  let any = false;
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const img = await loadImage(`${host}${path}/${TILE}/${Z}/${tx}/${ty}/${SCHEME}.png`);
      if (img) { cx.drawImage(img, tx * TILE - x0, ty * TILE - y0); any = true; }
    }
  }
  if (!any) return null;
  const data = cx.getImageData(0, 0, size, size).data;
  const grid = new Float32Array(size * size);
  for (let i = 0, p = 0; i < grid.length; i++, p += 4)
    grid[i] = intensity(data[p], data[p + 1], data[p + 2], data[p + 3]);
  return grid;
}

const at = (grid, x, y) => {
  const size = RADIUS * 2 + 1;
  if (x < 0 || y < 0 || x >= size || y >= size) return 0;
  return grid[y * size + x];
};

// Intensity-weighted centroid of the echo in a field, or null if there's too little to
// be meaningful. This is what drives the motion estimate.
function centroid(grid) {
  const size = RADIUS * 2 + 1;
  let sx = 0, sy = 0, w = 0, n = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = grid[y * size + x];
      if (v > 0) { sx += x * v; sy += y * v; w += v; n++; }
    }
  }
  if (n < 40 || w <= 0) return null;      // a few stray pixels aren't a trackable field
  return { x: sx / w, y: sy / w, n };
}

// Estimate cell motion (px/frame) from centroid movement across the recent frame series.
// A brute-force block correlator was both slow and unstable when fronts grew or faded.
// Centroids are O(pixels) and degrade to null instead of producing a bogus zero vector;
// the agreement check below filters frames whose echo shapes change inconsistently.
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Use the median of every consecutive valid centroid displacement. The old implementation
// compared one arbitrarily chosen old frame with the newest; one cell appearing at the edge
// could swing that single vector across the map and produce a very confident, very wrong
// line. Requiring a majority of frame-to-frame vectors to agree rejects that failure mode.
function estimateMotion(fields) {
  const samples = [];
  let previous = null, previousIndex = -1;
  fields.forEach((field, index) => {
    const point = field ? centroid(field) : null;
    if (!point) return;
    if (previous) {
      const gap = index - previousIndex;
      if (gap > 0) samples.push({
        vx: (point.x - previous.x) / gap,
        vy: (point.y - previous.y) / gap,
      });
    }
    previous = point;
    previousIndex = index;
  });
  if (samples.length < 2) return null;
  const vx = median(samples.map((s) => s.vx));
  const vy = median(samples.map((s) => s.vy));
  const magnitude = Math.hypot(vx, vy);
  if (magnitude < 0.1) return null;
  const agreeing = samples.filter((s) => {
    const sm = Math.hypot(s.vx, s.vy);
    return sm > 0.05 && (s.vx * vx + s.vy * vy) / (sm * magnitude) >= 0.7;
  }).length;
  if (agreeing < Math.ceil(samples.length * 0.75)) return null;
  return { vx, vy, samples: samples.length };
}

const compass16 = (deg) => {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
};

// Public: produce the same shape radar.js's panel expects, from radar frames + location.
// Returns null on any shortfall so the caller keeps the server forecast.
export async function radarNowcast(env, lat, lon) {
  try {
    if (!env || !env.frames || !env.host) return null;
    const frames = env.frames;
    const pastCount = env.past_count ?? frames.length;
    const past = frames.slice(0, pastCount);            // observed frames only, oldest->newest
    if (past.length < 2) return null;
    const use = past.slice(-MAX_FRAMES);
    const gx = lon2x(lon) * TILE, gy = lat2y(lat) * TILE;
    const c = RADIUS;

    const fields = [];
    for (const f of use) fields.push(await sampleField(env.host, f.path, gx, gy));
    const last = fields[fields.length - 1];
    if (!last) return null;
    const stepMin = Math.max(
      5, Math.round((use[use.length - 1].time - use[use.length - 2].time) / 60) || 10);
    const raw = estimateMotion(fields);
    let vx = raw ? raw.vx : 0;
    let vy = raw ? raw.vy : 0;
    const metresPerPixel = 156543.03392 * Math.cos((lat * Math.PI) / 180) / 2 ** Z;
    let speedKmh = Math.hypot(vx, vy) * metresPerPixel / 1000 * (60 / stepMin);
    // A near-zero vector cannot support an ETA, while a faster result is a changing storm
    // shape masquerading as translation. In either case use the model forecast and draw no
    // line instead of presenting invented precision.
    if (speedKmh < 2 || speedKmh > 130) {
      vx = 0;
      vy = 0;
      speedKmh = 0;
    }
    const canPredict = Boolean(vx || vy);
    const nowV = at(last, c, c);
    const raining = levelOf(nowV) !== "none";

    // If it is dry and the observed frames do not yield trustworthy movement, this radar
    // data says nothing about the future. Returning null lets callers use Open-Meteo rather
    // than repeating the current dry pixel for two hours and claiming a forecast.
    if (!canPredict && !raining) return null;

    // Advect: intensity expected at the point in k steps = what's k*velocity upwind now.
    // Take the strongest value in a small patch around that upwind point, not a single
    // pixel - a front rarely tracks exactly along the centroid vector, and one stray
    // transparent pixel shouldn't read as "no rain".
    const upwindAt = (k) => {
      const px = c - vx * k, py = c - vy * k;
      let peak = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          peak = Math.max(peak, at(last, Math.round(px + dx), Math.round(py + dy)));
        }
      }
      return peak;
    };
    const future = [nowV];
    const maxComponent = Math.max(Math.abs(vx), Math.abs(vy));
    const availableSteps = canPredict
      ? Math.min(HORIZON, Math.floor((RADIUS - 4) / maxComponent)) : 0;
    for (let k = 1; k <= availableSteps; k++) future.push(upwindAt(k));

    let startIdx = null, stopIdx = null;
    if (raining) {
      for (let k = 1; k < future.length; k++) if (levelOf(future[k]) === "none") { stopIdx = k; break; }
    } else {
      for (let k = 1; k < future.length; k++) if (levelOf(future[k]) !== "none") { startIdx = k; break; }
    }

    // Direction the weather is coming FROM (opposite the motion vector; screen y is down).
    let fromCompass = null;
    if (canPredict) fromCompass = compass16((Math.atan2(-vx, vy) * 180) / Math.PI);

    const timeline = future.map((v) => ({ mm: Math.round(v * 100) / 100, prob: null }));

    // Where is the echo that reaches us in ~1 hour? It's sitting `velocity * 60min` upwind
    // right now, so convert that pixel offset back to a real coordinate for the map to
    // draw a line to. Only meaningful if the field is actually moving and there IS echo
    // there - otherwise the line would point confidently at empty sky.
    let inbound = null;
    if (canPredict) {
      // Point at the cell that will actually REACH you: the first future step with rain in
      // it, within the next hour. (Using a fixed 60-minute point instead meant that when
      // rain was due in 20 minutes the hour mark was clear sky, so no line was drawn at all
      // - technically correct, useless in practice.) If it's already raining, look ahead to
      // whatever is next in the hour.
      const kMax = Math.max(1, Math.round(60 / stepMin));
      const limit = Math.min(kMax, future.length - 1);
      let kTarget = null;
      for (let k = 1; k <= limit; k++) {
        if (levelOf(future[k]) !== "none") {
          kTarget = k;
          if (!raining) break;            // dry: nearest inbound echo gives the start ETA
        }
      }
      if (kTarget != null) {
        const sx = gx - vx * kTarget, sy = gy - vy * kTarget;
        const intensityThere = upwindAt(kTarget);   // same 7×7 sample used by the prediction
        inbound = {
          lat: y2lat(sy),
          lon: x2lon(sx),
          minutes: Math.round(kTarget * stepMin),
          level: levelOf(intensityThere),
          speed_kmh: Math.round(speedKmh),
        };
      }
    }

    return {
      inbound,
      raining_now: raining,
      level: raining ? levelOf(nowV) : levelOf(Math.max(...future)),
      status: raining ? "raining" : (startIdx != null ? "starting" : "dry"),
      minutes_until_start: startIdx != null ? startIdx * stepMin : null,
      minutes_until_stop: stopIdx != null ? stopIdx * stepMin : null,
      from_compass: fromCompass,
      peak_mm: Math.max(...future),
      horizon_minutes: (future.length - 1) * stepMin,
      timeline,
      source: "radar",
    };
  } catch (e) {
    return null;     // never break the page over a nowcast
  }
}

export const __test = { RADIUS, intensity, levelOf, centroid, estimateMotion };
