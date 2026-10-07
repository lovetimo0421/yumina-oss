import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBar, VBAR_W } from "./bar-place";

const page = { width: 375, height: 800 };
const meter = { top: 240, left: 10, width: 140, height: 20 };

test("the bar sits above a part when that covers nothing", () => {
  assert.deepEqual(placeBar(meter, [], page, 240), { top: 240 - 34 - 24, left: 10, vertical: false });
});

test("it moves below rather than cover the readout above", () => {
  const readout = { top: 190, left: 10, width: 140, height: 40 };
  assert.equal(placeBar(meter, [readout], page, 240).top, 240 + 20 + 10);
});

test("covered on both sides, it stands on end in the margin beside the page", () => {
  const title = { top: 20, left: 20, width: 300, height: 30 };
  const readout = { top: 60, left: 20, width: 140, height: 40 };
  const side = placeBar(title, [readout], page, 330, { left: 200, right: 200 });
  assert.deepEqual(side, { top: 20, left: 375 + 10, vertical: true });
  assert.equal(placeBar(title, [readout], page, 330, { left: 200, right: 0 }).left, -VBAR_W - 10);
});

test("with no margin it takes the side that covers less", () => {
  const above = { top: 190, left: 10, width: 140, height: 40 };
  const below = { top: 270, left: 10, width: 140, height: 4 };
  assert.equal(placeBar(meter, [above, below], page, 240).top, 240 + 20 + 10);
  assert.equal(placeBar({ ...meter, top: 20 }, [], page, 240).top, 20 + 20 + 10, "no room above the top of the page");
});
