/**
 * Any open model on Hugging Face, on the player's own GPU.
 *
 * Ollama pulls GGUF files straight from Hugging Face (`ollama pull
 * hf.co/<owner>/<repo>:<quant>`), so the guide's three tested models are not
 * the limit — the hard part for a player is knowing which repo has a GGUF,
 * which of its dozen quantizations fits their card, and how to spell the
 * command. These helpers answer those three from the public HF API.
 */

export interface GgufQuant {
  /** Ollama tag, e.g. "Q4_K_M". */
  quant: string;
  /** Total bytes across split files. */
  bytes: number;
  /** Rough VRAM needed: weights plus room for the context cache. */
  vramGb: number;
  command: string;
}

/** Accepts a full URL, `hf.co/...`, or a bare `owner/repo`. */
export function parseHfRepo(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  s = s.replace(/^ollama\s+(pull|run)\s+/i, "");
  s = s.replace(/^https?:\/\//i, "").replace(/^(www\.)?(huggingface\.co|hf\.co)\//i, "");
  s = s.replace(/:[^/]*$/, ""); // an Ollama-style ":Q4_K_M" suffix
  const parts = s.split(/[/?#]/).filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  const ok = /^[\w.-]+$/;
  if (!ok.test(owner) || !ok.test(repo) || owner === "models" || owner === "datasets" || owner === "spaces") return null;
  return `${owner}/${repo}`;
}

// Longest first so "Q4_K_M" doesn't match as "Q4_K".
const QUANT_RE = /(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z]+(?:_[A-Z]+)?|Q\d_K_[SMLX]{1,2}|Q\d_K|Q\d_\d|Q\d|TQ\d_\d|MXFP4(?:_MOE)?|BF16|F16|F32))(?=[-_.])/i;

/** Quant tag of one GGUF file, or null for files that aren't a model (mmproj, imatrix). */
export function quantOf(path: string): string | null {
  const file = path.split("/").pop() ?? path;
  if (!/\.gguf$/i.test(file) || /mmproj|imatrix/i.test(file)) return null;
  const m = file.match(QUANT_RE);
  return m ? m[1].toUpperCase() : null;
}

/** Weights + KV cache for an 8K–16K context, rounded up to whole GB. */
export function vramFor(bytes: number): number {
  const gb = bytes / 1e9;
  return Math.ceil(gb * 1.1 + 1.5);
}

export function pullCommand(repo: string, quant: string): string {
  return `ollama pull hf.co/${repo}:${quant}`;
}

/** Group a repo's file listing into one entry per quantization, smallest first. */
export function ggufQuants(repo: string, files: Array<{ path: string; size?: number; type?: string }>): GgufQuant[] {
  const totals = new Map<string, number>();
  for (const f of files) {
    if (f.type && f.type !== "file") continue;
    const quant = quantOf(f.path);
    if (!quant) continue;
    totals.set(quant, (totals.get(quant) ?? 0) + (f.size ?? 0));
  }
  return [...totals]
    .map(([quant, bytes]) => ({ quant, bytes, vramGb: vramFor(bytes), command: pullCommand(repo, quant) }))
    .sort((a, b) => a.bytes - b.bytes);
}

/**
 * The quant we'd point most players at: Q4_K_M (or unsloth's UD-Q4_K_XL) is
 * the common sweet spot; otherwise the largest one under 24 GB of VRAM,
 * otherwise the smallest.
 */
export function recommendedQuant(quants: GgufQuant[]): string | null {
  if (!quants.length) return null;
  const q4 = quants.find((q) => q.quant === "Q4_K_M")
    ?? quants.find((q) => q.quant === "UD-Q4_K_XL")
    ?? quants.find((q) => /Q4_K/.test(q.quant));
  if (q4) return q4.quant;
  const fits = quants.filter((q) => q.vramGb <= 24);
  return (fits.length ? fits[fits.length - 1] : quants[0]).quant;
}

/** Shorter label for `hf.co/bartowski/Some-Model-GGUF:Q4_K_M` in the picker. */
export function prettyLocalModelName(name: string): string {
  const m = name.match(/^hf\.co\/[^/]+\/([^:]+)(?::(.+))?$/i);
  if (!m) return name;
  const base = m[1].replace(/[-_]GGUF$/i, "");
  return m[2] ? `${base} · ${m[2]}` : base;
}

const HF = "https://huggingface.co";

export type HfLookup =
  | { kind: "quants"; repo: string; quants: GgufQuant[] }
  /** The repo has no GGUF (original weights) — these community repos do. */
  | { kind: "alternatives"; repo: string; repos: Array<{ id: string; downloads: number }> }
  | { kind: "notFound"; repo: string }
  | { kind: "noGguf"; repo: string };

export async function lookupHfRepo(repo: string, signal?: AbortSignal): Promise<HfLookup> {
  const res = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`, { signal });
  if (res.status === 404 || res.status === 401) return { kind: "notFound", repo };
  if (!res.ok) throw new Error(`HF ${res.status}`);
  const files = (await res.json()) as Array<{ path: string; size?: number; type?: string }>;
  const quants = ggufQuants(repo, files);
  if (quants.length) return { kind: "quants", repo, quants };

  const name = repo.split("/")[1];
  const search = await fetch(`${HF}/api/models?search=${encodeURIComponent(name)}&filter=gguf&sort=downloads&direction=-1&limit=5`, { signal });
  const repos = search.ok ? ((await search.json()) as Array<{ id: string; downloads?: number }>) : [];
  const alternatives = repos.filter((r) => r.id !== repo).map((r) => ({ id: r.id, downloads: r.downloads ?? 0 }));
  return alternatives.length ? { kind: "alternatives", repo, repos: alternatives } : { kind: "noGguf", repo };
}
