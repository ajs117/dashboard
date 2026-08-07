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
// Motion is measured across frames this far apart, not adjacent ones: at ~10 min/frame a
// typical front only shifts a couple of px per frame at z7, which the correlator can't
// separate from cells growing/decaying (it was returning ~0 and predicting "dry" with rain
// 40px upwind). A longer baseline gives a displacement big enough to measure, then we
// divide back down to per-frame.
const MOTION_SPAN = 3;

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

// Estimate cell motion (px/frame) by tracking how the echo's centroid moves between two
// fields. This replaced a brute-force block correlator: on real data that search took 77s
// on the Pi AND still returned (0,0), because a front entering the window looks like echo
// appearing rather than shifting. The centroid moves measurably (observed x: 12->21->27->
// 35->47 over consecutive frames as a front approached), it's O(pixels) instead of
// O(pixels x search area), and it degrades to null instead of a bogus zero.
function motionCentroid(prev, cur) {
  const a = centroid(prev), b = centroid(cur);
  if (!a || !b) return null;
  return { vx: b.x - a.x, vy: b.y - a.y };
}

// (kept for reference / small-window use) Block-matching motion estimate.
function motion(prev, cur) {
  // SEARCH covers the displacement over MOTION_SPAN frames (not one), so it must be wide
  // enough for a fast front: ~30px at z7 ≈ 90km/h over 3x10min.
  const size = RADIUS * 2 + 1, SEARCH = 40, c = RADIUS;
  const HALF = RADIUS - SEARCH - 2;       // correlation patch, kept inside the search range
  const STEP = 3;                         // subsample: 4x cheaper on a Zero 2W, same answer
  let best = Infinity, bvx = 0, bvy = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let err = 0, n = 0, overlap = 0;
      // Correlate over most of the window so a front that has moved 20-40px still has
      // material to match against (scaled to RADIUS, not a fixed ±18px).
      for (let y = c - HALF; y <= c + HALF; y += STEP) {
        for (let x = c - HALF; x <= c + HALF; x += STEP) {
          const a = at(cur, x, y), b = at(prev, x - dx, y - dy);
          if (a > 0 || b > 0) overlap++;
          err += Math.abs(a - b); n++;
        }
      }
      // With little echo in view any shift matches equally well, so a plain mean would pick
      // an arbitrary (often zero) vector. Require some echo, and keep the tie-break gentle
      // relative to the longer baseline.
      if (overlap < 12) continue;
      err = err / n + 0.0015 * Math.hypot(dx, dy);   // prefer the smaller motion on ties
      if (err < best) { best = err; bvx = dx; bvy = dy; }
    }
  }
  return { vx: bvx, vy: bvy };
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
    // Motion over a MOTION_SPAN-frame baseline (see the constant): find the newest valid
    // field that far back, measure the total displacement, then divide down to per-frame.
    let prev = null, span = 0;
    for (let i = fields.length - 1 - MOTION_SPAN; i >= 0; i--) {
      if (fields[i]) { prev = fields[i]; span = (fields.length - 1) - i; break; }
    }
    if (!prev) {   // not enough history for a long baseline - fall back to the newest pair
      for (let i = fields.length - 2; i >= 0; i--) {
        if (fields[i]) { prev = fields[i]; span = (fields.length - 1) - i; break; }
      }
    }
    const raw = prev ? motionCentroid(prev, last) : null;
    const vx = raw && span ? raw.vx / span : 0;
    const vy = raw && span ? raw.vy / span : 0;

    const stepMin = Math.max(
      5, Math.round((use[use.length - 1].time - use[use.length - 2].time) / 60) || 10);
    const nowV = at(last, c, c);
    const raining = levelOf(nowV) !== "none";

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
    for (let k = 1; k <= HORIZON; k++) future.push(upwindAt(k));

    let startIdx = null, stopIdx = null;
    if (raining) {
      for (let k = 1; k < future.length; k++) if (levelOf(future[k]) === "none") { stopIdx = k; break; }
    } else {
      for (let k = 1; k < future.length; k++) if (levelOf(future[k]) !== "none") { startIdx = k; break; }
    }

    // Direction the weather is coming FROM (opposite the motion vector; screen y is down).
    let fromCompass = null;
    if (vx || vy) fromCompass = compass16((Math.atan2(-vx, vy) * 180) / Math.PI);

    const timeline = future.map((v) => ({ mm: Math.round(v * 100) / 100, prob: null }));

    // Where is the echo that reaches us in ~1 hour? It's sitting `velocity * 60min` upwind
    // right now, so convert that pixel offset back to a real coordinate for the map to
    // draw a line to. Only meaningful if the field is actually moving and there IS echo
    // there - otherwise the line would point confidently at empty sky.
    let inbound = null;
    if (vx || vy) {
      // Point at the cell that will actually REACH you: the first future step with rain in
      // it, within the next hour. (Using a fixed 60-minute point instead meant that when
      // rain was due in 20 minutes the hour mark was clear sky, so no line was drawn at all
      // - technically correct, useless in practice.) If it's already raining, look ahead to
      // whatever is next in the hour.
      const kMax = Math.max(1, Math.round(60 / stepMin));
      let kTarget = null;
      for (let k = 1; k <= Math.min(kMax, HORIZON); k++) {
        if (levelOf(future[k]) !== "none") { kTarget = k; break; }
      }
      if (kTarget == null && raining) kTarget = kMax;    // raining now: show the hour mark
      if (kTarget == null) kTarget = 0;                  // nothing inbound -> skipped below
      const sx = gx - vx * kTarget, sy = gy - vy * kTarget;
      const intensityThere = kTarget
        ? at(last, Math.round(c - vx * kTarget), Math.round(c - vy * kTarget)) : 0;
      inbound = {
        lat: y2lat(sy),
        lon: x2lon(sx),
        minutes: Math.round(kTarget * stepMin),
        level: kTarget ? levelOf(intensityThere) : "none",
        // px/frame -> km/h, for a human-readable speed on the map label.
        speed_kmh: Math.round(
          (Math.hypot(vx, vy) * (156543.03392 * Math.cos((lat * Math.PI) / 180) / 2 ** Z))
          / 1000 * (60 / stepMin)),
      };
    }

    // Movement of the radar field itself, reported whenever we can measure it - it is a
    // "which way is the weather going" indicator, so it must NOT be gated on rain being
    // present or inbound. Direction is the direction of travel (where cells are heading).
    const kHour = 60 / stepMin;
    const motionOut = (vx || vy)
      ? {
        dx: vx, dy: vy,                       // px/frame at z7; screen y is down
        // Where the weather that reaches us in an hour is sitting RIGHT NOW: one hour of
        // travel upwind. Lets the map draw a line whose tip actually means "60 minutes
        // away", rather than an arbitrary fixed length.
        hour_lat: y2lat(gy - vy * kHour),
        hour_lon: x2lon(gx - vx * kHour),
        bearing: compass16((Math.atan2(vx, -vy) * 180) / Math.PI),
        speed_kmh: Math.round(
          (Math.hypot(vx, vy) * (156543.03392 * Math.cos((lat * Math.PI) / 180) / 2 ** Z))
          / 1000 * (60 / stepMin)),
      }
      : null;

    return {
      inbound,
      motion: motionOut,
      raining_now: raining,
      level: raining ? levelOf(nowV) : levelOf(Math.max(...future)),
      status: raining ? "raining" : (startIdx != null ? "starting" : "dry"),
      minutes_until_start: startIdx != null ? startIdx * stepMin : null,
      minutes_until_stop: stopIdx != null ? stopIdx * stepMin : null,
      from_compass: fromCompass,
      peak_mm: Math.max(...future),
      timeline,
      source: "radar",
    };
  } catch (e) {
    return null;     // never break the page over a nowcast
  }
}
