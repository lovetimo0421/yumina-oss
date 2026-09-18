import assert from "node:assert/strict";
import test from "node:test";
import {
  detectFormat,
  parseImportedFile,
  parseImportedFileFlexible,
} from "./import-world";
import {
  isTavernCharacterCard,
  isTavernWorldbook,
} from "./convert-tavern-card";
import { writePngTextChunk, utf8ToBase64 } from "./png-metadata";

// 1x1 PNG, no metadata (same fixture used by png-metadata.test.ts).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function tinyPng(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_PNG_B64, "base64"));
}

function fileFromBytes(bytes: Uint8Array, name: string, type: string): File {
  // Copy into a fresh ArrayBuffer so the BlobPart type accepts it.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new File([copy.buffer], name, { type });
}

test("parseImportedFile yields the PNG image as the world cover", async () => {
  const card = {
    spec: "chara_card_v2",
    data: { name: "Naoko", description: "A warm neighbor.", first_mes: "Hi!" },
  };
  const png = writePngTextChunk(tinyPng(), "chara", utf8ToBase64(JSON.stringify(card)));
  const file = fileFromBytes(png, "naoko.png", "image/png");

  const { world, coverImage } = await parseImportedFile(file);

  assert.equal(world.name, "Naoko");
  assert.ok(coverImage, "expected a cover image for a PNG card");
  assert.equal(coverImage!.type, "image/png");
  assert.equal(coverImage!.size, png.byteLength);
});

test("parseImportedFile returns no cover for a JSON card", async () => {
  const card = {
    spec: "chara_card_v2",
    data: { name: "JsonOnly", description: "no image", first_mes: "yo" },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const file = fileFromBytes(bytes, "card.json", "application/json");

  const { world, coverImage } = await parseImportedFile(file);

  assert.equal(world.name, "JsonOnly");
  assert.equal(coverImage, null);
});

test("standalone world_info with empty name/description imports as a worldbook", async () => {
  // Real SillyTavern world_info exports may include these empty top-level
  // strings. The old V1 fallback treated their mere presence as a character
  // card and silently converted the worldbook into a valid 0-entry world.
  const worldbook = {
    name: "",
    description: "",
    scan_depth: 2,
    token_budget: 2048,
    recursive_scanning: false,
    entries: {
      "1": {
        uid: 1,
        key: ["Aethel"],
        keysecondary: [],
        comment: "Setting",
        content: "The world of Aethel.",
        constant: false,
        disable: false,
        order: 100,
        position: 1,
      },
      "2": {
        uid: 2,
        key: ["Crucible"],
        keysecondary: [],
        comment: "The Crucible",
        content: "A crucible of mortal ambition.",
        constant: false,
        disable: false,
        order: 90,
        position: 1,
      },
    },
  };

  assert.equal(isTavernWorldbook(worldbook), true);
  assert.equal(isTavernCharacterCard(worldbook), false);
  assert.equal(detectFormat(worldbook), "tavern-worldbook");

  const bytes = new TextEncoder().encode(JSON.stringify(worldbook));
  const file = fileFromBytes(bytes, "aethel_world_info.json", "application/json");
  const { world, coverImage } = await parseImportedFile(file);

  assert.equal(world.name, "Imported Worldbook");
  assert.equal(world.entries.length, 2);
  assert.deepEqual(
    world.entries.map((entry) => entry.name),
    ["Setting", "The Crucible"],
  );
  assert.equal(coverImage, null);
});

test("V1 character cards without object-mapped entries remain supported", async () => {
  const card = {
    name: "Legacy Character",
    description: "A V1 character.",
    first_mes: "Hello.",
  };

  assert.equal(detectFormat(card), "tavern-card");

  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const file = fileFromBytes(bytes, "legacy-character.json", "application/json");
  const { world } = await parseImportedFile(file);

  assert.equal(world.name, "Legacy Character");
  assert.equal(world.entries.length, 2);
});

test("parseImportedFileFlexible detects a bundle JSON as a bundle", async () => {
  const bundle = {
    bundleVersion: "1.0.0",
    name: "Combat Pack",
    description: "adds combat",
    createdAt: new Date().toISOString(),
    entries: [{ id: "e1" }],
    variables: [{ id: "v1", name: "hp" }],
    rules: [{ id: "r1" }],
    tags: ["combat"],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const file = fileFromBytes(bytes, "combat-pack.json", "application/json");

  const result = await parseImportedFileFlexible(file);

  assert.equal(result.kind, "bundle");
  if (result.kind === "bundle") {
    assert.equal(result.bundle.name, "Combat Pack");
    assert.equal(result.bundle.entries.length, 1);
  }
});

test("parseImportedFileFlexible detects a world JSON as a world", async () => {
  const world = {
    version: "1.0.0",
    name: "My World",
    entries: [],
    variables: [],
    rules: [],
    components: [],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(world));
  const file = fileFromBytes(bytes, "world.json", "application/json");

  const result = await parseImportedFileFlexible(file);

  assert.equal(result.kind, "world");
  if (result.kind === "world") {
    assert.equal(result.world.name, "My World");
    assert.equal(result.coverImage, null);
  }
});
