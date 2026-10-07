import { describe, it, expect } from "vitest";
import { extractVariableReadsFromFiles } from "../variable-read-scan.js";

// "Which variables does the UI actually read?" is the question the canvas
// could never answer — and the one behind the nastiest class of card bug
// (a HUD bound to a variable nothing ever writes).

const scan = (src: string) => extractVariableReadsFromFiles({ "index.tsx": src });

describe("extractVariableReadsFromFiles", () => {
  it("finds dotted reads off api.variables", () => {
    const r = scan(`export default function App({ api }) {
      return <div>HP {api.variables.health} / Gold {api.variables.gold}</div>;
    }`);
    expect(r.names.sort()).toEqual(["gold", "health"]);
    expect(r.dynamicReads).toBe(0);
  });

  it("finds bracketed string reads", () => {
    const r = scan(`const a = api.variables["submission"]; const b = api.variables['mood'];`);
    expect(r.names.sort()).toEqual(["mood", "submission"]);
  });

  it("finds destructured reads", () => {
    const r = scan(`const { health, gold: money, stamina } = api.variables;`);
    expect(r.names.sort()).toEqual(["gold", "health", "stamina"]);
  });

  it("follows an alias binding", () => {
    const r = scan(`const v = api.variables;\nreturn <span>{v.affection} {v["trust"]}</span>;`);
    expect(r.names.sort()).toEqual(["affection", "trust"]);
  });

  it("still binds an alias guarded with a fallback", () => {
    const r = scan(`const v = api.variables || {};\nreturn <b>{v.gold}</b>;`);
    expect(r.names).toEqual(["gold"]);
  });

  // The shape real cards are written in: one const per field. Treating those
  // names as aliases for the whole bag turned every `.length` / `.filter()`
  // on them into a phantom variable read.
  it("does not treat a single extracted field as an alias for the bag", () => {
    const r = scan(
      `const day = api.variables['day-count'] || 1;\n` +
      `const clueLog = api.variables['clue-log'] || [];\n` +
      `const n = clueLog.filter(Boolean).length;\n` +
      `const next = day.toFixed(0);`,
    );
    expect(r.names.sort()).toEqual(["clue-log", "day-count"]);
  });

  it("does not treat a dotted extraction as an alias either", () => {
    const r = scan(`const hp = api.variables.health;\nreturn <b>{hp.toFixed(1)}</b>;`);
    expect(r.names).toEqual(["health"]);
  });

  it("follows the useYumina() destructuring the docs teach", () => {
    const r = scan(`const { variables, messages } = useYumina();\nreturn <b>{variables.scene_bg}</b>;`);
    expect(r.names).toEqual(["scene_bg"]);
  });

  it("reads the props.variables shape a few cards use", () => {
    const r = scan(`return <b>{props.variables.gold}</b>;`);
    expect(r.names).toEqual(["gold"]);
  });

  it("reads the window global HTML scripts use", () => {
    const r = extractVariableReadsFromFiles({ "index.html": `<script>console.log(yumina.variables.gold)</script>` });
    expect(r.names).toEqual(["gold"]);
  });

  it("counts computed keys instead of pretending it saw them", () => {
    const r = scan(`const key = pick(); const v = api.variables[key]; const w = api.variables[\`slot_\${i}\`];`);
    expect(r.names).toEqual([]);
    expect(r.dynamicReads).toBe(2);
  });

  it("does not confuse globalVariables with variables", () => {
    const r = scan(`const a = api.globalVariables.coins; const b = api.variables.hp;`);
    expect(r.names).toEqual(["hp"]);
  });

  it("ignores method calls that merely live on the same object path", () => {
    const r = scan(`api.setVariable("hp", 5); api.variables.hp;`);
    expect(r.names).toEqual(["hp"]);
  });

  it("dedupes across files and returns a stable order", () => {
    const r = extractVariableReadsFromFiles({
      "b.tsx": `api.variables.zeta; api.variables.alpha;`,
      "a.tsx": `api.variables.alpha;`,
    });
    expect(r.names).toEqual(["alpha", "zeta"]);
  });

  it("survives a file that is not a string", () => {
    const r = extractVariableReadsFromFiles({ "x.tsx": undefined as unknown as string });
    expect(r.names).toEqual([]);
    expect(r.writes).toEqual([]);
  });

  it("finds the variables the UI writes itself", () => {
    const r = scan(`onClick={() => api.setVariable("affection", v + 1)}; api.setVariable('mood', 'calm');`);
    expect(r.writes).toEqual(["affection", "mood"]);
    expect(r.dynamicWrites).toBe(0);
  });

  it("counts a computed write target rather than guessing it", () => {
    const r = scan(`api.setVariable(slotKey, 1); api.setVariable("hp", 2);`);
    expect(r.writes).toEqual(["hp"]);
    expect(r.dynamicWrites).toBe(1);
  });
});
