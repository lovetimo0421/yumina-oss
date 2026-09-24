import assert from "node:assert/strict";
import test from "node:test";
import { assetFolderTrail, chatAssetQuery } from "./chat-asset-folders";
import type { AssetFolder } from "@/stores/user-assets";

const folder = (id: string, parentFolderId: string | null): AssetFolder => ({ id, parentFolderId, name: id, userId: "owner", assetCount: 0, createdAt: "" });
test("nested folders have a root-to-current breadcrumb; siblings stay out", () => {
  const folders = [folder("characters", null), folder("scenes", null), folder("forest", "scenes"), folder("night", "forest")];
  assert.deepEqual(assetFolderTrail(folders, "night").map(value => value.id), ["scenes", "forest", "night"]);
  assert.deepEqual(assetFolderTrail(folders, null), []);
});
test("missing parents and malformed cycles cannot trap folder navigation", () => {
  assert.deepEqual(assetFolderTrail([folder("orphan", "deleted")], "orphan").map(value => value.id), ["orphan"]);
  assert.equal(assetFolderTrail([folder("a", "b"), folder("b", "a")], "a").length, 2);
});
test("root only lists unfiled images; folder search and pagination keep the same scope", () => {
  const root = new URLSearchParams(chatAssetQuery(null, "", 1));
  assert.equal(root.get("folderId"), "root");
  assert.equal(root.get("type"), "image");
  const nested = new URLSearchParams(chatAssetQuery("night", " 星光 & moon ", 3));
  assert.equal(nested.get("folderId"), "night");
  assert.equal(nested.get("search"), "星光 & moon");
  assert.equal(nested.get("offset"), "48");
  assert.equal(nested.get("limit"), "24");
  assert.equal(nested.get("sort"), "newest");
});
