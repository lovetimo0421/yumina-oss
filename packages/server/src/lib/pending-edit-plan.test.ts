import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planMaterialHold, type PendingEditRow } from "./pending-edit-plan.js";
import { versionDraftValues, type VersionMaterial, type VersionWorld } from "./world-version-history.js";

// Only the fields consumed by these pure planners are relevant to this fixture.
const world = {
  id: "world", creatorId: "owner", name: "Current title", status: "published", isPublished: true,
  schema: {
    id: "world", version: "20.0.0", name: "Current title", firstMessage: "Live opening",
    entries: [{ id: "intro", name: "Introduction", content: "Approved lore", enabled: true }],
    variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }],
    rules: [],
  },
  thumbnailUrl: "live.webp", ageRating: "all", languageGroupId: "language-group",
  updatedAt: new Date("2026-06-01T00:00:00Z"),
} as unknown as VersionWorld;

function restoredDraft(material: VersionMaterial) {
  return {
    ...versionDraftValues(world, material, null),
    id: "held", createdAt: new Date("2026-06-01T00:00:00Z"), status: "draft" as const,
  };
}

function nextSave(existing: PendingEditRow | null, material: VersionMaterial) {
  return planMaterialHold({
    worldId: world.id, creatorId: world.creatorId,
    live: { ...world, ageRating: world.ageRating ?? "all" },
    existing, proposedSchema: material.schema,
    proposedThumbnailUrl: material.thumbnailUrl, proposedAgeRating: material.ageRating ?? "all",
  });
}

describe("version draft persistence across subsequent editor and Studio saves", () => {
  it("keeps restored variable-only drafts held across another nonmaterial save", () => {
    const material = {
      ...world,
      schema: { ...world.schema, variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 20 }] },
    };
    const restored = restoredDraft(material);
    assert.equal(restored.preserveDraft, true);
    assert.deepEqual(restored.reasons, []);
    const editedAgain = { ...material, schema: { ...material.schema, firstMessage: "Draft opening" } };
    const plan = nextSave(restored, editedAgain);
    assert.ok(plan.upsert, "empty material reasons must not mean this draft goes live");
    assert.equal(plan.clearWorldId, null);
    assert.equal(plan.upsert.preserveDraft, true);
    assert.deepEqual(plan.reasons, []);
    assert.deepEqual(plan.upsert.schema, editedAgain.schema);
    assert.equal(plan.upsert.groupKey, "language-group");
    assert.equal(plan.upsert.baseUpdatedAt, world.updatedAt);
  });

  it("still lets ordinary nonmaterial saves apply immediately", () => {
    const material = { ...world, schema: { ...world.schema, firstMessage: "An ordinary edit" } };
    const fresh = nextSave(null, material);
    assert.equal(fresh.upsert, null);
    assert.equal(fresh.clearWorldId, null);
    assert.deepEqual(fresh.reasons, []);
    const ordinaryOldHold = { ...restoredDraft(material), preserveDraft: false };
    const revertedMaterial = nextSave(ordinaryOldHold, material);
    assert.equal(revertedMaterial.upsert, null);
    assert.equal(revertedMaterial.clearWorldId, world.id);
  });

  it("clears a restored draft only after every content and material value matches live", () => {
    const restored = restoredDraft({ ...world, schema: { ...world.schema, firstMessage: "Older opening" } });
    const plan = nextSave(restored, world);
    assert.equal(plan.upsert, null);
    assert.equal(plan.clearWorldId, world.id);
    assert.deepEqual(plan.reasons, []);
    // Equal material alone is insufficient: a remaining opening/variable change
    // must not silently clear the preserved working copy.
    assert.ok(nextSave(restored, { ...world, schema: restored.schema }).upsert);
  });

  it("keeps material restores held and carries their update notes through further edits", () => {
    const material = {
      ...world, thumbnailUrl: "draft.webp", ageRating: "adult",
      schema: { ...world.schema, entries: [{ id: "intro", name: "Introduction", content: "Restored lore", enabled: true }] },
    };
    const previous = {
      ...restoredDraft(material), updateTitle: "Next chapter", updateContent: "Author notes", updateIsMajor: true,
    };
    const restored = { ...versionDraftValues(world, material, previous), status: "draft" as const };
    const plan = nextSave(restored, { ...material, schema: { ...material.schema, firstMessage: "Still editing" } });
    assert.ok(plan.upsert);
    assert.equal(plan.upsert.preserveDraft, true);
    assert.ok(plan.reasons.includes("entries"));
    assert.ok(plan.reasons.includes("cover"));
    assert.ok(plan.reasons.includes("ageRating"));
    assert.equal(plan.upsert.isNsfw, true);
    assert.equal(plan.upsert.updateTitle, "Next chapter");
    assert.equal(plan.upsert.updateContent, "Author notes");
    assert.equal(plan.upsert.updateIsMajor, true);
  });

  it("turns a queued preserved draft into a fresh draft when a save supersedes it", () => {
    const material = { ...world, schema: { ...world.schema, firstMessage: "Queued opening" } };
    const queued = {
      ...restoredDraft(material), status: "pending" as const,
      submittedAt: new Date("2026-06-02T00:00:00Z"),
      rejectionReason: "old-reason", rejectionDetail: "old-detail",
    };
    const plan = nextSave(queued, { ...material, schema: { ...material.schema, firstMessage: "Newer opening" } });
    assert.ok(plan.upsert);
    assert.equal(plan.upsert.status, "draft");
    assert.equal(plan.upsert.submittedAt, null);
    assert.equal(plan.upsert.reviewedAt, null);
    assert.equal(plan.upsert.reviewedBy, null);
    assert.equal(plan.upsert.rejectionReason, null);
    assert.equal(plan.upsert.rejectionDetail, null);
    assert.equal(plan.upsert.preserveDraft, true);
    assert.equal(plan.clearWorldId, null);
  });

  it("does not clear queued content until the caller has arranged review withdrawal", () => {
    const queued = { ...restoredDraft(world), status: "pending" as const };
    assert.equal(nextSave(queued, world).clearWorldId, null);
    // PATCH/Studio atomically withdraw the submission and pass status=draft to
    // the planner. Only then may matching-live content remove the stale hold.
    const superseded = nextSave({ ...queued, status: "draft" }, world);
    assert.equal(superseded.upsert, null);
    assert.equal(superseded.clearWorldId, world.id);
  });
});
