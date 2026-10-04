import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSET_ARCHIVE_LIMITS } from "@yumina/shared";
import { normalizeArchivePath, visitAssetArchive } from "./asset-archive.js";
import { tarFixture, zipFixture } from "./asset-archive-fixtures.js";

test("ZIP, TAR and compressed TAR preserve Unicode paths and exact file contents", async () => {
  const files = [{ name: "./角色/开心.txt", data: "你好" }, { name: "音频/theme.mp3", data: "sound" }, { name: "__MACOSX/._hero", data: "metadata" }, { name: "page.html", data: "<script>bad</script>" }];
  for (const [name, bytes] of [["assets.ZIP", zipFixture(files)], ["assets.tar", await tarFixture(files)], ["assets.tar.gz", await tarFixture(files, true)], ["assets.tgz", await tarFixture(files, true)]] as const) {
    const imported: [string, string, string][] = [];
    const result = await visitAssetArchive(bytes, name, async (file, data) => { imported.push([file.path, data.toString(), file.type]); });
    assert.deepEqual(imported, [["角色/开心.txt", "你好", "txt"], ["音频/theme.mp3", "sound", "audio"]]);
    assert.equal(result.files, 2);
    assert.equal(result.ignored, 2);
  }
});

test("archive paths cannot escape the selected folder or hide ambiguous separators", () => {
  for (const name of ["../secret", "a/../../b", "/etc/passwd", "C:/file", "a\\b", "a\0b", "a\nb", Array.from({ length: 17 }, () => "a").join("/")]) assert.throws(() => normalizeArchivePath(name), /ARCHIVE_UNSAFE_PATH/, name);
  assert.equal(normalizeArchivePath("./assets/背景/教室.png"), "assets/背景/教室.png");
});

test("archived MP4 and WebM files retain the video type used by filtering and previews", async () => {
  const found: [string, string, string][] = [];
  await visitAssetArchive(zipFixture([{ name: "scene.MP4", data: "mp4" }, { name: "scene.webm", data: "webm" }]), "videos.zip", async file => {
    found.push([file.path, file.type, file.mimeType]);
  });
  assert.deepEqual(found, [["scene.MP4", "video", "video/mp4"], ["scene.webm", "video", "video/webm"]]);
});

test("encrypted, linked, duplicate and corrupt ZIP entries fail before an import is approved", async () => {
  const noop = async () => {};
  await assert.rejects(visitAssetArchive(zipFixture([{ name: "a.txt", flags: 1, data: "locked" }]), "a.zip", noop), /ARCHIVE_ENCRYPTED/);
  await assert.rejects(visitAssetArchive(zipFixture([{ name: "link", mode: 0xa1ff, data: "target" }]), "a.zip", noop), /ARCHIVE_LINK_NOT_ALLOWED/);
  await assert.rejects(visitAssetArchive(zipFixture([{ name: "a.txt" }, { name: "./a.txt" }]), "a.zip", noop), /ARCHIVE_DUPLICATE_PATH/);
  const damaged = zipFixture([{ name: "a.txt", data: "good" }]);
  damaged[35] = 0xff;
  await assert.rejects(visitAssetArchive(damaged, "a.zip", noop), /ARCHIVE_INVALID/);
  await assert.rejects(visitAssetArchive(Buffer.from("not a zip"), "a.zip", noop), /ARCHIVE_INVALID/);
});

test("TAR links, traversal, empty archives and excessive file counts are rejected", async () => {
  const noop = async () => {};
  await assert.rejects(visitAssetArchive(await tarFixture([{ name: "link", type: "symlink", linkname: "../secret" }]), "a.tar", noop), /ARCHIVE_LINK_NOT_ALLOWED/);
  await assert.rejects(visitAssetArchive(await tarFixture([{ name: "../secret", data: "x" }]), "a.tar", noop), /ARCHIVE_UNSAFE_PATH/);
  await assert.rejects(visitAssetArchive(await tarFixture([]), "a.tar", noop), /ARCHIVE_EMPTY/);
  const huge = zipFixture(Array.from({ length: ASSET_ARCHIVE_LIMITS.files + 1 }, (_, i) => ({ name: `${i}.txt` })));
  await assert.rejects(visitAssetArchive(huge, "a.zip", noop), /ARCHIVE_TOO_MANY_FILES/);
});

test("file byte limits are checked from ZIP metadata before inflation", async () => {
  const zip = zipFixture([{ name: "huge.bin", data: "x" }]);
  const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  // Advertise a deflated oversized file with only a byte of payload.
  zip.writeUInt16LE(8, 8);
  zip.writeUInt16LE(8, central + 10);
  zip.writeUInt32LE(ASSET_ARCHIVE_LIMITS.fileBytes + 1, 22);
  zip.writeUInt32LE(ASSET_ARCHIVE_LIMITS.fileBytes + 1, central + 24);
  await assert.rejects(visitAssetArchive(zip, "a.zip", async () => { assert.fail("must not deliver oversized data"); }), /ARCHIVE_FILE_TOO_LARGE/);
});
