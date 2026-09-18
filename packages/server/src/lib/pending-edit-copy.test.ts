import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateWorldCopyTokens,
  resolveCopyMaterialForViewer,
  selectWorldCopyMaterial,
} from "./world-copy-material.js";

describe("selectWorldCopyMaterial", () => {
  const liveSchema = {
    id: "world-schema",
    version: "20.0.0",
    rootComponent: {
      id: "world-schema:root",
      name: "Root",
      entryFile: "index.tsx",
      files: { "index.tsx": "export default function App() { return <Panel />; }" },
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  };

  const workingSchema = {
    ...liveSchema,
    rootComponent: {
      ...liveSchema.rootComponent,
      files: {
        "index.tsx":
          "export default function App() { return <><Panel /><Chat /></>; }",
      },
      updatedAt: "2026-08-13T00:00:00.000Z",
    },
  };

  const live = {
    schema: liveSchema,
    thumbnailUrl: "approved-cover.webp",
    ageRating: "all",
    isNsfw: false,
  };

  it("copies the creator's held UI, including the restored Chat wrapper", () => {
    const material = selectWorldCopyMaterial(live, {
      schema: workingSchema,
      thumbnailUrl: "working-cover.webp",
      ageRating: "adult",
    });
    const root = material.schema["rootComponent"] as typeof workingSchema.rootComponent;

    assert.match(root.files["index.tsx"], /<Chat\s*\/>/);
    assert.equal(material.thumbnailUrl, "working-cover.webp");
    assert.equal(material.ageRating, "adult");
    assert.equal(material.isNsfw, true);
  });

  it("uses live material when the viewer is not authorized for a held edit", () => {
    const material = selectWorldCopyMaterial(live, null);
    const root = material.schema["rootComponent"] as typeof liveSchema.rootComponent;

    assert.doesNotMatch(root.files["index.tsx"], /<Chat\s*\/>/);
    assert.equal(material.thumbnailUrl, "approved-cover.webp");
    assert.equal(material.ageRating, "all");
    assert.equal(material.isNsfw, false);
  });

  it("preserves an intentional held-cover removal and defaults a historical null rating", () => {
    const material = selectWorldCopyMaterial(
      { ...live, ageRating: "adult", isNsfw: true },
      { schema: workingSchema, thumbnailUrl: null, ageRating: null },
    );

    assert.equal(material.thumbnailUrl, null);
    assert.equal(material.ageRating, "all");
    assert.equal(material.isNsfw, false);
  });

  it("clears the sensitive flag when a held rating becomes all-ages", () => {
    const material = selectWorldCopyMaterial(
      { ...live, ageRating: "adult", isNsfw: true },
      { schema: workingSchema, thumbnailUrl: null, ageRating: "all" },
    );

    assert.equal(material.ageRating, "all");
    assert.equal(material.isNsfw, false);
  });

  it("loads a held edit only for the creator of a published card", async () => {
    const world = {
      ...live,
      id: "world-1",
      status: "published",
      creatorId: "creator-1",
    };

    const creatorMaterial = await resolveCopyMaterialForViewer(
      world,
      "creator-1",
      async () => ({
        schema: workingSchema,
        thumbnailUrl: null,
        ageRating: null,
      }),
    );

    assert.equal(creatorMaterial.schema, workingSchema);
  });

  it("does not load or leak a held edit to another user", async () => {
    const world = {
      ...live,
      id: "world-1",
      status: "published",
      creatorId: "creator-1",
    };
    let loaderCalled = false;

    const otherUserMaterial = await resolveCopyMaterialForViewer(
      world,
      "other-user",
      async () => {
        loaderCalled = true;
        return {
          schema: workingSchema,
          thumbnailUrl: null,
          ageRating: null,
        };
      },
    );

    assert.equal(loaderCalled, false);
    assert.equal(otherUserMaterial.schema, liveSchema);
  });

  it("does not look for held material when the creator copies a draft", async () => {
    const world = {
      ...live,
      id: "world-1",
      status: "draft",
      creatorId: "creator-1",
    };
    let loaderCalled = false;

    const material = await resolveCopyMaterialForViewer(
      world,
      "creator-1",
      async () => {
        loaderCalled = true;
        return null;
      },
    );

    assert.equal(loaderCalled, false);
    assert.equal(material.schema, liveSchema);
  });

  it("falls back to live material when the creator has no held edit", async () => {
    const world = {
      ...live,
      id: "world-1",
      status: "published",
      creatorId: "creator-1",
    };

    const material = await resolveCopyMaterialForViewer(
      world,
      "creator-1",
      async () => null,
    );

    assert.equal(material.schema, liveSchema);
  });

  it("propagates a held-material read failure", async () => {
    const world = {
      ...live,
      id: "world-1",
      status: "published",
      creatorId: "creator-1",
    };

    await assert.rejects(
      resolveCopyMaterialForViewer(world, "creator-1", async () => {
        throw new Error("held material unavailable");
      }),
      /held material unavailable/,
    );
  });

  it("safely handles malformed entries in a legacy schema", () => {
    assert.equal(estimateWorldCopyTokens({ entries: { content: "not-an-array" } }), 0);
    assert.equal(estimateWorldCopyTokens({ entries: [null, "bad", { content: 42 }] }), 0);

    const unreadableSchema = new Proxy<Record<string, unknown>>({}, {
      get() {
        throw new Error("unreadable schema");
      },
    });
    assert.equal(estimateWorldCopyTokens(unreadableSchema), 0);
  });

  it("recomputes tokens from copied entry content", () => {
    assert.ok(estimateWorldCopyTokens({ entries: [{ content: "one two three four" }] }) > 0);
  });
});
