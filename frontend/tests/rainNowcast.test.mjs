import assert from "node:assert/strict";
import test from "node:test";

import { __test } from "../js/modules/rainNowcast.js";

const { RADIUS, intensity, levelOf, estimateMotion, patchLevel } = __test;
const SIZE = RADIUS * 2 + 1;

function field(cx, cy) {
  const grid = new Float32Array(SIZE * SIZE);
  for (let y = cy - 4; y <= cy + 4; y++) {
    for (let x = cx - 4; x <= cx + 4; x++) grid[y * SIZE + x] = 0.5;
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
    field(45, 90),
    field(49, 88),
    field(53, 86),
    field(57, 84),
  ]);
  assert.ok(result);
  assert.equal(result.vx, 4);
  assert.equal(result.vy, -2);
});

test("motion estimate rejects contradictory frame movement", () => {
  const result = estimateMotion([
    field(45, 90),
    field(49, 90),
    field(45, 90),
  ]);
  assert.equal(result, null);
});

test("motion estimate rejects a perpendicular direction change", () => {
  const result = estimateMotion([
    field(60, 60),
    field(64, 60),
    field(64, 56),
    field(68, 56),
  ]);
  assert.equal(result, null);
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
