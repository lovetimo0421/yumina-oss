import assert from "node:assert/strict";
import test from "node:test";
import { isActiveContentType } from "./asset-mime.js";

test("pages and scripts are active whatever parameters or case they carry", () => {
  for (const type of [
    "text/html", "TEXT/HTML", "text/html; charset=utf-8", " text/html ;x=1", "application/xhtml+xml",
    "image/svg+xml", "image/svg+xml;charset=utf-8", "application/xml", "text/xml", "application/rss+xml",
    "text/plain, text/html", "text/plain; charset=utf-8", "application/pdf;x", '"text/html"', "html",
    "text/javascript", "application/javascript", "application/x-javascript", "application/ecmascript", "text/jscript",
  ]) assert.equal(isActiveContentType(type), true, type);
});

test("ordinary card files are not active", () => {
  for (const type of [
    "image/png", "image/webp", "audio/mpeg", "video/mp4", "font/woff2", "application/json", "text/plain",
    "text/markdown", "text/csv", "application/octet-stream", "model/gltf-binary", "application/pdf", "application/zip", "", undefined, null,
  ]) assert.equal(isActiveContentType(type), false, String(type));
});
