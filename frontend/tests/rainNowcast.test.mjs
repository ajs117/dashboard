import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../js/modules/rainNowcast.js";

const { RADIUS, intensity, levelOf, estimateMotion, patchLevel } = __test;
const SIZE = RADIUS * 2 + 1;

function field(cx, cy) {
  const grid = new Float32Array(SIZE * SIZE);
  for (let y = cy - 6; y <= cy + 6; y++) {
    for (let x = cx - 6; x <= cx + 6; x++) grid[y * SIZE + x] = 0.5;
  }
  return grid;
}

test("RainViewer palette ignores terrain and recognises rain echoes", () => {
  assert.equal(intensity(108, 104, 93, 36), 0);
  assert.equal(intensity(136, 221, 238, 255) > 0, true);
  assert.equal(levelOf(intensity(255, 170, 0, 255)), "heavy");
});

test("motion estimate follows a consistently translated echo", () => {
  const result = estimateMotion([
    field(86, 96),
    field(90, 93),
    field(94, 90),
    field(98, 87),
  ]);
  assert.ok(result);
  // Matching happens on a downsampled pyramid, so the answer is close rather than exact.
  assert.ok(Math.abs(result.vx - 4) < 1.5, `vx ${result.vx}`);
  assert.ok(Math.abs(result.vy + 3) < 1.5, `vy ${result.vy}`);
});

test("motion estimate rejects contradictory frame movement", () => {
  const result = estimateMotion([
    field(86, 90),
    field(94, 90),
    field(86, 90),
  ]);
  assert.equal(result, null);
});

test("motion estimate rejects a perpendicular direction change", () => {
  const result = estimateMotion([
    field(84, 96),
    field(92, 96),
    field(92, 88),
    field(100, 88),
  ]);
  assert.equal(result, null);
});

test("motion tracks the pattern, not the centre of mass", () => {
  // The failure this replaced a centroid tracker over: a band travelling north while echo
  // upstream of it intensifies. The weighted mean of the field crawls SOUTH (measured at
  // +2.9 px/frame on this very case) even though every feature in it moves north.
  const frame = (t) => {
    const grid = new Float32Array(SIZE * SIZE);
    const top = RADIUS - 20 - 6 * t;                       // the band, marching north
    for (let y = top; y < top + 40; y++) {
      if (y < 0 || y >= SIZE) continue;
      for (let x = 20; x < SIZE - 20; x++)
        grid[y * SIZE + x] = 0.3 + 0.25 * Math.sin(x * 0.7 + (y - top) * 0.4);
    }
    for (let y = RADIUS + 45; y <= RADIUS + 75; y++)       // upstream, brightening in place
      for (let x = 30; x < SIZE - 30; x++) grid[y * SIZE + x] = 0.1 + 0.12 * t;
    return grid;
  };
  const result = estimateMotion([0, 1, 2, 3, 4].map(frame));
  assert.ok(result, "a translating band must be trackable");
  assert.ok(result.vy < -4, `expected northward motion, got vy ${result.vy}`);
});

test("a single qualifying pixel is not rain", () => {
  const size = RADIUS * 2 + 1;
  const grid = new Float32Array(size * size);
  const c = RADIUS;
  grid[c * size + c] = intensity(136, 221, 238, 255);   // one light-cyan pixel dead centre
  assert.equal(levelOf(patchLevel(grid, c, c)), "none");
});

test("a genuinely wet area reads as rain", () => {
  const size = RADIUS * 2 + 1;
  const grid = new Float32Array(size * size);
  const c = RADIUS;
  const v = intensity(136, 221, 238, 255);
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) grid[(c + dy) * size + (c + dx)] = v;
  assert.notEqual(levelOf(patchLevel(grid, c, c)), "none");
});

test("LIGHT stays above intensity()'s floor so \"none\" is reachable", () => {
  // intensity() never returns between 0 and 0.10. If LIGHT slipped to or below that floor,
  // every pixel clearing the alpha/hue test would read as rain and "none" would be dead.
  const floor = intensity(0, 255, 255, 120);
  assert.equal(floor, 0.1);
  assert.equal(levelOf(floor), "none");
});

test("a narrow leading edge is still detectable upwind", () => {
  // The forecast path must stay sensitive to a front clipping only a column or two of the
  // sample patch - using the median there hides an approaching edge until it has arrived,
  // and the inbound line never draws.
  const size = RADIUS * 2 + 1;
  const c = RADIUS;
  const v = intensity(136, 221, 238, 255);
  for (const cols of [1, 2, 3]) {
    const grid = new Float32Array(size * size);
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = 0; dx < cols; dx++) grid[(c + dy) * size + (c - 3 + dx)] = v;
    let peak = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) peak = Math.max(peak, grid[(c + dy) * size + (c + dx)]);
    assert.notEqual(levelOf(peak), "none", `${cols}/7 columns should register upwind`);
    assert.equal(levelOf(patchLevel(grid, c, c)), "none", `${cols}/7 is not raining here yet`);
  }
});
