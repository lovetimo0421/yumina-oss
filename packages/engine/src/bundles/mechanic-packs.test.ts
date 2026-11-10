import { describe, it, expect } from "vitest";
import {
  MECHANIC_PACK_IDS,
  mechanicPack,
  mechanicPackSummaries,
} from "./mechanic-packs.js";

const LANGS = ["zh", "zh-Hant", "ja", "en", "es"];

describe("mechanic packs", () => {
  it("builds every pack in every shipped language", () => {
    for (const lang of LANGS) {
      for (const id of MECHANIC_PACK_IDS) {
        const bundle = mechanicPack(id, lang);
        expect(bundle, `${id} in ${lang}`).not.toBeNull();
        expect(bundle!.name.length, `${id} in ${lang} has a name`).toBeGreaterThan(0);
        expect(bundle!.bundleVersion).toBe("3.0.0");
      }
    }
  });

  it("never fills both rules and reactions", () => {
    // The runtime evaluates both arrays; a behaviour in each would fire twice.
    for (const id of MECHANIC_PACK_IDS) {
      const bundle = mechanicPack(id, "en")!;
      expect(bundle.rules, id).toHaveLength(0);
      expect((bundle.reactions ?? []).length, id).toBeGreaterThan(0);
    }
  });

  it("points every behaviour at a variable the same pack ships", () => {
    // A pack whose behaviour writes a variable it did not bring installs a
    // behaviour that silently does nothing.
    for (const id of MECHANIC_PACK_IDS) {
      const bundle = mechanicPack(id, "en")!;
      const owned = new Set(bundle.variables.map((v) => v.id));
      for (const reaction of bundle.reactions ?? []) {
        for (const effect of reaction.then) {
          if (effect.type !== "set") continue;
          if (effect.path.startsWith("@")) continue; // directive / entry writes
          expect(owned.has(effect.path), `${id}: ${reaction.name} writes ${effect.path}`).toBe(true);
        }
        for (const condition of reaction.conditions) {
          expect(owned.has(condition.variableId), `${id}: ${reaction.name} reads ${condition.variableId}`).toBe(true);
        }
      }
    }
  });

  it("gives the affection pack keywords in the language it was asked for", () => {
    // The whole reason the strings are per-language: an English keyword list
    // in a Chinese card matches nothing, and nothing about the card says so.
    const zh = mechanicPack("affection", "zh")!;
    const zhWarm = zh.reactions!.find((r) => r.when.eventType === "message:user")!;
    expect(String(zhWarm.when.match!.content!.value)).toContain("谢谢");

    const en = mechanicPack("affection", "en")!;
    const enWarm = en.reactions!.find((r) => r.when.eventType === "message:user")!;
    expect(String(enWarm.when.match!.content!.value)).toContain("thank you");
    expect(String(enWarm.when.match!.content!.value)).not.toContain("谢谢");

    const hant = mechanicPack("affection", "zh-Hant")!;
    const hantWarm = hant.reactions!.find((r) => r.when.eventType === "message:user")!;
    expect(String(hantWarm.when.match!.content!.value)).toContain("謝謝");
  });

  it("falls back to English for a language with no authored pack", () => {
    expect(mechanicPack("affection", "de")!.name).toBe(mechanicPack("affection", "en")!.name);
    expect(mechanicPack("affection", undefined)!.name).toBe(mechanicPack("affection", "en")!.name);
  });

  it("keeps every meter inside its own range", () => {
    for (const id of MECHANIC_PACK_IDS) {
      for (const v of mechanicPack(id, "en")!.variables) {
        if (typeof v.defaultValue !== "number") continue;
        expect(v.defaultValue, `${id}/${v.name} default`).toBeGreaterThanOrEqual(v.min ?? -Infinity);
        expect(v.defaultValue, `${id}/${v.name} default`).toBeLessThanOrEqual(v.max ?? Infinity);
      }
    }
  });

  it("tells the AI what each meter means", () => {
    // A number with no behaviourRules is a number the model will not move.
    const affection = mechanicPack("affection", "zh")!;
    for (const v of affection.variables) {
      expect((v.behaviorRules ?? "").length, v.name).toBeGreaterThan(20);
    }
  });

  it("only claims determinism for packs that actually ship variables", () => {
    const summaries = mechanicPackSummaries("en");
    const panel = summaries.find((s) => s.id === "panel")!;
    const affection = summaries.find((s) => s.id === "affection")!;
    expect(panel.deterministic).toBe(false);
    expect(panel.variables).toBe(0);
    expect(affection.deterministic).toBe(true);
  });

  it("counts what it promises", () => {
    for (const summary of mechanicPackSummaries("en")) {
      const bundle = mechanicPack(summary.id, "en")!;
      expect(summary.variables).toBe(bundle.variables.length);
      expect(summary.behaviors).toBe(bundle.reactions!.length);
      expect(summary.entries).toBe(bundle.entries.length);
    }
  });

  it("marks pack lore always-on", () => {
    // A rulebook gated behind a keyword explains the numbers only when the
    // player happens to say the magic word.
    for (const id of MECHANIC_PACK_IDS) {
      for (const entry of mechanicPack(id, "en")!.entries) {
        expect(entry.alwaysSend, `${id}/${entry.name}`).toBe(true);
        expect(entry.enabled).toBe(true);
      }
    }
  });

  it("keeps the random-event pack random", () => {
    const events = mechanicPack("events", "en")!;
    const chances = events.reactions!.map((r) => r.chance).filter((c): c is number => typeof c === "number");
    expect(chances.length).toBeGreaterThan(0);
    for (const c of chances) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(100);
    }
  });
});
