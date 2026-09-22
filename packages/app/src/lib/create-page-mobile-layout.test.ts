import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../routes/app/worlds.create.tsx", import.meta.url),
  "utf8",
);

test("Create keeps desktop panes and identifies its mobile document scroll surface", () => {
  assert.match(
    source,
    /className="create-shell flex h-full min-h-0 w-full overflow-hidden[^\"]*md:overflow-y-auto/,
  );
  assert.match(
    source,
    /className="create-col mx-auto flex h-full min-h-0[^\"]*flex-col md:h-auto/,
  );
  assert.match(
    source,
    /className="create-mobile-grid mt-\[clamp\([^\"]+\)\] grid min-h-0 flex-1 auto-rows-fr grid-cols-1 gap-\[clamp\([^\"]+\)\] md:hidden"/,
  );
  assert.match(source, /className="group relative grid min-h-0 cursor-pointer/);
  assert.match(source, /data-scroll-restoration-id="create-picker"/);
  assert.doesNotMatch(source, /min-h-28/);
});

test("mobile create picker only renders the existing top back control", () => {
  const picker = source.slice(
    source.indexOf("function TemplatePicker"),
    source.indexOf("function ModeSelectionDialog"),
  );

  assert.equal(picker.match(/onClick=\{onBack\}/g)?.length, 2);
  assert.doesNotMatch(picker, /hover-surface mt-auto h-11/);
});
