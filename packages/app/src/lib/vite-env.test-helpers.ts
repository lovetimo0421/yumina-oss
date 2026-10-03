import { registerHooks } from "node:module";

// These fixtures execute the real store/module graph in Node rather than Vite.
// Apply Vite's compile-time env boundary without changing or mocking store logic.
const sourceRoot = new URL("../", import.meta.url).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.startsWith(sourceRoot) || loaded.source == null) return loaded;
    const source = typeof loaded.source === "string" ? loaded.source : new TextDecoder().decode(loaded.source);
    if (!source.includes("import.meta.env")) return loaded;
    return { ...loaded, source: source.replaceAll("import.meta.env", "({})") };
  },
});
