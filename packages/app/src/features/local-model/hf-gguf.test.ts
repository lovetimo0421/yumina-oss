import assert from "node:assert/strict";
import test from "node:test";
import { ggufQuants, parseHfRepo, prettyLocalModelName, quantOf, recommendedQuant } from "./hf-gguf";

test("parseHfRepo accepts links, hf.co paths, bare ids and ollama commands", () => {
  assert.equal(parseHfRepo("https://huggingface.co/NousResearch/Arete-27B"), "NousResearch/Arete-27B");
  assert.equal(parseHfRepo("https://huggingface.co/bartowski/NousResearch_Arete-27B-GGUF/tree/main"), "bartowski/NousResearch_Arete-27B-GGUF");
  assert.equal(parseHfRepo("hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M"), "bartowski/NousResearch_Arete-27B-GGUF");
  assert.equal(parseHfRepo("ollama run hf.co/a/b:Q8_0"), "a/b");
  assert.equal(parseHfRepo("  owner/repo.v2  "), "owner/repo.v2");
  assert.equal(parseHfRepo("https://huggingface.co/models?search=qwen"), null);
  assert.equal(parseHfRepo("qwen3.8:27b"), null);
  assert.equal(parseHfRepo(""), null);
});

test("quantOf reads the tag and skips non-model files", () => {
  assert.equal(quantOf("NousResearch_Arete-27B-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(quantOf("Arete-27B.IQ3_XS.gguf"), "IQ3_XS");
  assert.equal(quantOf("Q8_0/model-Q8_0-00001-of-00002.gguf"), "Q8_0");
  assert.equal(quantOf("model-UD-Q4_K_XL.gguf"), "UD-Q4_K_XL");
  assert.equal(quantOf("model-bf16.gguf"), "BF16");
  assert.equal(quantOf("mmproj-model-f16.gguf"), null);
  assert.equal(quantOf("README.md"), null);
});

test("ggufQuants sums split files and sorts smallest first", () => {
  const quants = ggufQuants("o/r", [
    { path: "r-Q8_0-00001-of-00002.gguf", size: 15e9, type: "file" },
    { path: "r-Q8_0-00002-of-00002.gguf", size: 14e9, type: "file" },
    { path: "r-Q4_K_M.gguf", size: 17.2e9, type: "file" },
    { path: "r-IQ3_XS.gguf", size: 12.6e9, type: "file" },
    { path: "Q8_0", type: "directory" },
  ]);
  assert.deepEqual(quants.map((q) => q.quant), ["IQ3_XS", "Q4_K_M", "Q8_0"]);
  assert.equal(quants[2].bytes, 29e9);
  assert.equal(quants[1].command, "ollama pull hf.co/o/r:Q4_K_M");
  assert.equal(quants[1].vramGb, 21);
  assert.equal(recommendedQuant(quants), "Q4_K_M");
  assert.equal(recommendedQuant(quants.filter((q) => q.quant !== "Q4_K_M")), "IQ3_XS");
  const unsloth = ggufQuants("u/r", [
    { path: "r-UD-Q5_K_M.gguf", size: 19e9 },
    { path: "r-UD-Q4_K_XL.gguf", size: 17e9 },
    { path: "r-UD-IQ2_M.gguf", size: 9e9 },
  ]);
  assert.equal(recommendedQuant(unsloth), "UD-Q4_K_XL");
});


test("prettyLocalModelName shortens hf.co names only", () => {
  assert.equal(prettyLocalModelName("hf.co/bartowski/NousResearch_Arete-27B-GGUF:Q4_K_M"), "NousResearch_Arete-27B · Q4_K_M");
  assert.equal(prettyLocalModelName("qwen3.8:27b"), "qwen3.8:27b");
});
