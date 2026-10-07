import { describe, it, expect } from "vitest";
import { canConnect } from "../legality.js";
import type { GraphPort } from "../types.js";

const out = (type: GraphPort["type"]): GraphPort => ({ id: "o", type, direction: "out" });
const inp = (type: GraphPort["type"]): GraphPort => ({ id: "i", type, direction: "in" });

describe("canConnect", () => {
  it("allows out→in of the same type", () => {
    expect(canConnect(out("signal"), inp("signal"))).toBe(true);
  });
  it("rejects in→in (direction)", () => {
    expect(canConnect(inp("signal"), inp("signal"))).toBe(false);
  });
  it("rejects type mismatch (number into signal)", () => {
    expect(canConnect(out("number"), inp("signal"))).toBe(false);
  });
  it("allows a numeric value into a state port (variable read/write)", () => {
    expect(canConnect(out("number"), inp("state"))).toBe(true);
  });
  it("allows a state port to feed a numeric value port", () => {
    expect(canConnect(out("state"), inp("number"))).toBe(true);
  });
  it("rejects out→out (direction)", () => {
    expect(canConnect(out("signal"), out("signal"))).toBe(false);
  });
  it("allows a variable (state) to gate a module (activation condition)", () => {
    expect(canConnect(out("state"), inp("module"))).toBe(true);
  });
  it("allows a greeting select (signal) to activate a module", () => {
    expect(canConnect(out("signal"), inp("module"))).toBe(true);
  });
  it("allows a variable (state) to gate an entry", () => {
    expect(canConnect(out("state"), inp("entry"))).toBe(true);
  });
  it("still rejects a raw signal into an entry gate", () => {
    expect(canConnect(out("signal"), inp("entry"))).toBe(false);
  });
});
