import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsSource = readFileSync(
  new URL("../features/settings/settings-page.tsx", import.meta.url),
  "utf8",
);

const accountSection = settingsSource.slice(
  settingsSource.indexOf("function AccountSection"),
  settingsSource.indexOf("function DeleteAccountCard"),
);

test("the username input uses the standard inset without a hidden prefix gap", () => {
  assert.doesNotMatch(accountSection, />@<\/span>/);
  assert.match(
    accountSection,
    /value=\{editUsername\}[\s\S]*?className="[^"]*\bpx-3\b[^"]*"/,
  );
  assert.doesNotMatch(
    accountSection,
    /value=\{editUsername\}[\s\S]*?className="[^"]*\bpl-7\b[^"]*"/,
  );
});
