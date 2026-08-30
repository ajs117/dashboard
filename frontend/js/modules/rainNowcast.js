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
// LIGHT sits ABOVE intensity()'s 0.10 floor on purpose: every pixel that clears the alpha
// and hue tests scores at least 0.10, so a lower threshold makes "none" unreachable and one
// stray antialiased pixel reads as rain.
const LIGHT = 0.14, MODERATE = 0.5, HEAVY = 0.66;   // bucket thresholds on the scalar
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

// A tile that fails is not the same as a tile with no rain in it, and the difference decides
// whether the panel says "dry" over falling rain. The Pi's wifi drops the odd request, so
// retry with a short backoff before treating one as lost.
async function loadTile(src, tries = 3) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const img = await loadImage(src);
    if (img) return img;
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  return null;
}

// Render the RADIUS-window around (gx,gy) global pixels for one frame into a Float32 grid
// of intensities. Returns null unless EVERY tile covering the window loaded: a missing tile
// leaves a silent hole of zeroes, which reads as "no rain there" and is how the panel came
// to say dry in the rain. Better no answer than a confidently wrong one.
async function sampleField(host, path, gx, gy) {
  const x0 = Math.round(gx) - RADIUS, y0 = Math.round(gy) - RADIUS;
  const size = RADIUS * 2 + 1;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const tx0 = Math.floor(x0 / TILE), tx1 = Math.floor((x0 + size) / TILE);
  const ty0 = Math.floor(y0 / TILE), ty1 = Math.floor((y0 + size) / TILE);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const img = await loadTile(`${host}${path}/${TILE}/${Z}/${tx}/${ty}/${SCHEME}.png`);
      if (!img) return null;
      cx.drawImage(img, tx * TILE - x0, ty * TILE - y0);
    }
  }
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

// Representative intensity over a small patch: the median of the 7x7 around a point, so a
// verdict needs the area to be wet rather than one qualifying pixel.
function patchLevel(grid, x, y) {
  const vals = [];
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) vals.push(at(grid, x + dx, y + dy));
  vals.sort((a, b) => a - b);
  return vals[vals.length >> 1];
}

// --- motion ----------------------------------------------------------------------------
//
// Motion is measured by sliding consecutive frames over each other until they line up
// (template matching), NOT by tracking where the echo's centre of mass sits.
//
// The centroid version this replaces was measured against live radar getting the answer
// backwards: a band travelling north at 30 km/h left echo off the top of the window while
// new cells formed behind it, so the intensity-weighted mean crept SOUTH at 6 km/h. It was
// reporting growth and decay, not translation. Lining the patterns up reads the thing that
// actually advects, and on those same frames returned north at 30 km/h on all 7 pairs.

const SIZE = RADIUS * 2 + 1;
const COARSE = 6, FINE = 3;              // pyramid factors the search runs on
const COARSE_HALF = 9, FINE_HALF = 16;   // template half-width, in that level's own pixels
const COARSE_SPAN = 5;                   // ±30 full px/frame ≈ 135 km/h at a 10-minute step
// Mean template intensity below this means there is nothing to track. Kept low - roughly a
// single small shower - because the tie-break above and the agreement check below already
// handle a near-empty template; this only rejects the completely pointless case.
const MIN_TEMPLATE_WET = 0.001;

// Box-mean downsample of a square grid, so a ±30px search costs thousands of operations
// rather than millions - the Pi Zero has to do this every refresh.
function shrink(grid, factor) {
  const out = Math.floor(SIZE / factor);
  const small = new Float32Array(out * out);
  for (let y = 0; y < out; y++) {
    for (let x = 0; x < out; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++)
        for (let dx = 0; dx < factor; dx++) sum += grid[(y * factor + dy) * SIZE + x * factor + dx];
      small[y * out + x] = sum / (factor * factor);
    }
  }
  return small;
}

// How badly the newer frame's central template disagrees with the older frame displaced by
// (vx,vy). Samples off the edge count as dry, which is what the tile there would show.
function ssdAt(older, newer, size, half, vx, vy) {
  const c = size >> 1;
  let sum = 0;
  for (let y = c - half; y <= c + half; y++) {
    for (let x = c - half; x <= c + half; x++) {
      const ox = x - vx, oy = y - vy;
      const a = (ox < 0 || oy < 0 || ox >= size || oy >= size) ? 0 : older[oy * size + ox];
      const d = newer[y * size + x] - a;
      sum += d * d;
    }
  }
  return sum;
}

// The displacement that best slides the older frame under the newer one, searched over a
// square around `guess` then refined to sub-pixel by fitting a parabola to the error either
// side of the minimum. Ties go to the smaller displacement so a featureless pair returns
// ~zero rather than whichever corner the scan reached first.
function bestShift(older, newer, size, half, guessX, guessY, span) {
  let bx = guessX, by = guessY, best = Infinity;
  for (let vy = guessY - span; vy <= guessY + span; vy++) {
    for (let vx = guessX - span; vx <= guessX + span; vx++) {
      const s = ssdAt(older, newer, size, half, vx, vy);
      if (s < best || (s === best && vx * vx + vy * vy < bx * bx + by * by)) {
        best = s; bx = vx; by = vy;
      }
    }
  }
  const refine = (horizontal) => {
    const lo = ssdAt(older, newer, size, half, bx - (horizontal ? 1 : 0), by - (horizontal ? 0 : 1));
    const hi = ssdAt(older, newer, size, half, bx + (horizontal ? 1 : 0), by + (horizontal ? 0 : 1));
    const curve = lo - 2 * best + hi;
    if (curve <= 0) return 0;
    return Math.max(-0.5, Math.min(0.5, (lo - hi) / (2 * curve)));
  };
  return { vx: bx + refine(true), vy: by + refine(false) };
}

// Displacement in full-window px per frame between two consecutive fields: a wide coarse
// search, then a fine one around its answer. Null when the newer template is essentially
// dry, because the error surface is then flat and the best match arbitrary.
function pairShift(older, newer) {
  const fineSize = Math.floor(SIZE / FINE);
  const fineNew = shrink(newer, FINE);
  const c = fineSize >> 1;
  let wet = 0, n = 0;
  for (let y = c - FINE_HALF; y <= c + FINE_HALF; y++)
    for (let x = c - FINE_HALF; x <= c + FINE_HALF; x++) { wet += fineNew[y * fineSize + x]; n++; }
  if (wet / n < MIN_TEMPLATE_WET) return null;

  const coarseSize = Math.floor(SIZE / COARSE);
  const coarse = bestShift(shrink(older, COARSE), shrink(newer, COARSE),
                           coarseSize, COARSE_HALF, 0, 0, COARSE_SPAN);
  const scale = COARSE / FINE;
  const fine = bestShift(shrink(older, FINE), fineNew, fineSize, FINE_HALF,
                         Math.round(coarse.vx * scale), Math.round(coarse.vy * scale), 2);
  return { vx: fine.vx * FINE, vy: fine.vy * FINE };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Median of every adjacent-frame displacement. One pair can be thrown by a cell blowing up
// or a partly-loaded tile, so a majority of them have to agree on a direction before the
// vector is used at all - otherwise no line and no ETA.
function estimateMotion(fields) {
  const samples = [];
  for (let i = 1; i < fields.length; i++) {
    if (!fields[i - 1] || !fields[i]) continue;      // dropped frame: no adjacent pair here
    const shift = pairShift(fields[i - 1], fields[i]);
    if (shift) samples.push(shift);
  }
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
    // "Raining now" is a claim about this spot, so it needs the area to be wet: the median
    // of the patch, not one pixel. A single centre pixel could clear LIGHT off a stray
    // antialiased dot and report rain over a visibly clear gap.
    const nowV = patchLevel(last, c, c);
    const raining = levelOf(nowV) !== "none";

    // If it is dry and the observed frames do not yield trustworthy movement, this radar
    // data says nothing about the future. Returning null lets callers use Open-Meteo rather
    // than repeating the current dry pixel for two hours and claiming a forecast.
    if (!canPredict && !raining) return null;

    // Advect: intensity expected at the point in k steps = what's k*velocity upwind now.
    // Deliberately the PEAK of the patch, not its median: an approaching front's leading
    // edge may clip only a couple of columns, and a median misses it entirely until it has
    // already arrived. "Now" needs area to be convincing; "upwind" needs sensitivity.
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
    // Seeded with the peak (upwindAt(0)) so every bar in the timeline is the same statistic;
    // `raining` above stays on the stricter median.
    const future = [upwindAt(0)];
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

    // Movement of the radar field itself, independent of whether any rain reaches us.
    // The map's green upwind line is drawn from this, so it stays on a dry map - it shows
    // which way the sky is moving, which is not a rain prediction.
    let motion = null;
    if (canPredict) {
      const kHour = Math.max(1, Math.round(60 / stepMin));
      motion = {
        dx: vx,
        dy: vy,
        hour_lat: y2lat(gy - vy * kHour),   // where the air reaching us in an hour sits now
        hour_lon: x2lon(gx - vx * kHour),
        speed_kmh: Math.round(speedKmh),
      };
    }

    return {
      motion,
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

export const __test = { RADIUS, intensity, levelOf, estimateMotion, pairShift, patchLevel };
