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
const RADIUS = 40;           // sample window half-size in px (~30 km at z7) — covers drift
const SCHEME = "4/1_1";      // same colour scheme the map draws, so tiles are cache-shared
const MAX_FRAMES = 8;        // most recent frames to consider (~80 min of history)
const HORIZON = 6;           // prediction steps (× frame interval ≈ next hour)

const lon2x = (lon) => ((lon + 180) / 360) * 2 ** Z;
const lat2y = (lat) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z;

// RGBA -> rain intensity scalar in [0,1]. Scheme 4 ramps blue(light) -> cyan -> green ->
// yellow -> red(heavy), so red-minus-blue tracks intensity; alpha gates "is there echo".
function intensity(r, g, b, a) {
  if (a < 40) return 0;
  return Math.max(0, Math.min(1, (r - b) / 255 / 2 + 0.45));
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

// Estimate cell motion (px/frame) by finding the shift that best aligns the newest two
// fields — classic radar advection. Searches a modest range; returns {vx,vy}.
function motion(prev, cur) {
  const size = RADIUS * 2 + 1, SEARCH = 12, c = RADIUS;
  let best = Infinity, bvx = 0, bvy = 0;
  for (let dy = -SEARCH; dy <= SEARCH; dy++) {
    for (let dx = -SEARCH; dx <= SEARCH; dx++) {
      let err = 0, n = 0;
      for (let y = c - 18; y <= c + 18; y += 2) {
        for (let x = c - 18; x <= c + 18; x += 2) {
          const a = at(cur, x, y), b = at(prev, x - dx, y - dy);
          err += Math.abs(a - b); n++;
        }
      }
      err = err / n + 0.004 * Math.hypot(dx, dy);   // prefer the smaller motion on ties
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
    // newest valid pair for motion
    let prev = null;
    for (let i = fields.length - 2; i >= 0; i--) if (fields[i]) { prev = fields[i]; break; }
    const { vx, vy } = prev ? motion(prev, last) : { vx: 0, vy: 0 };

    const stepMin = Math.max(
      5, Math.round((use[use.length - 1].time - use[use.length - 2].time) / 60) || 10);
    const nowV = at(last, c, c);
    const raining = levelOf(nowV) !== "none";

    // Advect: intensity expected at the point in k steps = what's k*velocity upwind now.
    const future = [nowV];
    for (let k = 1; k <= HORIZON; k++) future.push(at(last, Math.round(c - vx * k), Math.round(c - vy * k)));

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
    return {
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
