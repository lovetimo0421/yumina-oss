// The stored-compile contract lives in @yumina/shared (the server stamps cards
// too). Re-exported for the app's existing imports; dependency-free, so
// world-renderer can still import it without pulling in the compiler.
export { CARD_CODE_REQUEST_HEADERS, COMPILED_FORMAT_VERSION, hashRootFiles, isCompiledUsable, isCompiledValid } from "@yumina/shared";
export type { CompiledRoot } from "@yumina/shared";
