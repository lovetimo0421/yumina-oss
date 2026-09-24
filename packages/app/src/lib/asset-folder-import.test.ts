import test from "node:test";
import assert from "node:assert/strict";
import { importFolderFiles, planFolderImport, readDroppedAssets, type FolderImportState } from "./asset-folder-import";

function entry(path: string, type = "") {
  return { path, file: new File(["content"], path.split("/").at(-1)!, { type }) };
}
const fresh = (): FolderImportState => ({ folderIds: new Map(), completed: new Set() });

test("plans nested Chinese folder names and recognizes images and text without browser MIME types", () => {
  const plan = planFolderImport([entry("角色素材/立绘/白兰.PNG"), entry("角色素材/设定.txt"), entry("角色素材/嵌套/规则.json"), entry("角色素材/说明.md")]);
  assert.equal(plan.files.length, 4);
  assert.deepEqual(new Set(plan.directories), new Set(["角色素材", "角色素材/立绘", "角色素材/嵌套"]));
  assert.equal(plan.totalBytes, 28);
  assert.equal(plan.files[0].type, "image");
  assert.equal(plan.files[2].type, "txt");
});

test("skips unsupported content, malformed relative paths and duplicate files", () => {
  const plan = planFolderImport([
    entry("assets/page.html", "text/html"), entry("assets/icon.svg", "image/svg+xml"), entry("assets/movie.exe"),
    entry("assets/sound.zip"), entry("assets/../secret.txt"), entry("/root/a.txt"), entry("a//b.txt"),
    entry("a.txt"), entry("a.txt"), entry("a.jpg", "text/html"), entry("a.bmp", "image/bmp"),
  ]);
  assert.equal(plan.files.length, 1);
  assert.equal(plan.skipped.length, 10);
  assert.deepEqual(plan.directories, []);
});

test("folder import accepts video, animations, audio and fonts with missing MIME metadata", () => {
  const plan = planFolderImport(["clip.MP4", "clip.webm", "idle.gif", "idle.webp", "music.mp3", "font.woff2"].map(name => entry(`media/${name}`)));
  assert.deepEqual(plan.files.map(file => file.type), ["video", "video", "image", "image", "audio", "font"]);
  assert.deepEqual(plan.skipped, []);
});

test("creates each directory once under the selected destination and retains same filenames in different folders", async () => {
  const plan = planFolderImport([entry("素材/甲/a.png"), entry("素材/乙/a.png"), entry("素材/甲/b.txt")]);
  const created: [string, string | undefined][] = [];
  const uploaded: [string, string | undefined][] = [];
  const state = fresh();
  const failures = await importFolderFiles(plan, state, {
    parentFolderId: "selected", signal: new AbortController().signal,
    createFolder: async (name, parent) => { created.push([name, parent]); return { id: name }; },
    uploadFile: async (file, _type, folder) => { uploaded.push([file.name, folder]); return {}; },
    onProgress: () => {},
  });
  assert.deepEqual(created, [["素材", "selected"], ["甲", "素材"], ["乙", "素材"]]);
  assert.deepEqual(uploaded, [["a.png", "甲"], ["a.png", "乙"], ["b.txt", "甲"]]);
  assert.deepEqual(failures, []);
  assert.equal(state.completed.size, 3);
});

test("retry uploads only failures and reuses created folders", async () => {
  const plan = planFolderImport([entry("folder/a.png"), entry("folder/b.txt")]);
  const state = fresh();
  let creates = 0;
  const attempts: string[] = [];
  const options = {
    signal: new AbortController().signal,
    createFolder: async () => { creates++; return { id: "folder-id" }; },
    uploadFile: async (file: File) => { attempts.push(file.name); return file.name === "b.txt" && attempts.length === 2 ? null : {}; },
    onProgress: () => {},
  };
  assert.deepEqual(await importFolderFiles(plan, state, options), ["folder/b.txt"]);
  assert.deepEqual(await importFolderFiles(plan, state, options), []);
  assert.equal(creates, 1);
  assert.deepEqual(attempts, ["a.png", "b.txt", "b.txt"]);
});

test("failed parent never scatters files into root, and can be retried", async () => {
  const plan = planFolderImport([entry("folder/sub/a.txt"), entry("folder/sub/b.png")]);
  const state = fresh();
  let creates = 0, uploads = 0;
  const failed = await importFolderFiles(plan, state, {
    signal: new AbortController().signal,
    createFolder: async () => { creates++; throw new Error("Offline"); },
    uploadFile: async () => { uploads++; return {}; }, onProgress: () => {},
  });
  assert.equal(creates, 1);
  assert.equal(uploads, 0);
  assert.equal(failed.length, 2);
  assert.deepEqual(await importFolderFiles(plan, state, {
    signal: new AbortController().signal, createFolder: async (name) => ({ id: name }),
    uploadFile: async () => ({}), onProgress: () => {},
  }), []);
});

test("cancel finishes the in-flight file and leaves remaining files resumable", async () => {
  const plan = planFolderImport([entry("folder/a.txt"), entry("folder/b.txt")]);
  const state = fresh();
  const controller = new AbortController();
  await importFolderFiles(plan, state, {
    signal: controller.signal, createFolder: async () => ({ id: "folder" }),
    uploadFile: async () => { controller.abort(); return {}; }, onProgress: () => {},
  });
  assert.deepEqual([...state.completed], ["folder/a.txt"]);
});

test("cancel during folder creation does not start a file upload", async () => {
  const controller = new AbortController();
  let uploads = 0;
  await importFolderFiles(planFolderImport([entry("folder/a.txt")]), fresh(), {
    signal: controller.signal, createFolder: async () => { controller.abort(); return { id: "folder" }; },
    uploadFile: async () => { uploads++; return {}; }, onProgress: () => {},
  });
  assert.equal(uploads, 0);
});

function fileEntry(name: string): FileSystemEntry {
  return { name, isFile: true, isDirectory: false, file: (resolve: (file: File) => void) => resolve(new File(["x"], name)) } as unknown as FileSystemEntry;
}
test("drop traversal reads all directory batches, including more than 100 files", async () => {
  const children = Array.from({ length: 205 }, (_, index) => fileEntry(`${index}.txt`));
  let offset = 0, reads = 0;
  const dir = { name: "root", isDirectory: true, isFile: false, createReader: () => ({ readEntries: (resolve: (entries: FileSystemEntry[]) => void) => { reads++; resolve(children.slice(offset, offset += 100)); } }) } as unknown as FileSystemEntry;
  const data = { items: [{ kind: "file", webkitGetAsEntry: () => dir, getAsFile: () => null }], files: [] } as unknown as DataTransfer;
  const result = await readDroppedAssets(data);
  assert.equal(result.files.length, 205);
  assert.equal(result.files[204].path, "root/204.txt");
  assert.equal(result.hasDirectories, true);
  assert.equal(reads, 4);
});

test("drop fallback preserves ordinary files when directory APIs are unavailable", async () => {
  const file = new File(["a"], "a.mp3");
  assert.deepEqual(await readDroppedAssets({ items: [], files: [file] } as unknown as DataTransfer), { files: [{ file, path: "a.mp3" }], hasDirectories: false });
  assert.deepEqual(await readDroppedAssets({ items: [{ kind: "file", getAsFile: () => file }], files: [file] } as unknown as DataTransfer), { files: [{ file, path: "a.mp3" }], hasDirectories: false });
});

test("directory read errors propagate instead of silently importing a partial tree", async () => {
  const dir = { name: "root", isDirectory: true, createReader: () => ({ readEntries: (_resolve: unknown, reject: (error: Error) => void) => reject(new Error("Permission denied")) }) } as unknown as FileSystemEntry;
  await assert.rejects(readDroppedAssets({ items: [{ kind: "file", webkitGetAsEntry: () => dir, getAsFile: () => null }], files: [] } as unknown as DataTransfer), /Permission denied/);
});
