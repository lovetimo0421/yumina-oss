import test from "node:test";
import assert from "node:assert/strict";
import { templateFromDisplay, templateToDisplay } from "./template-names";

const vars = [
  { id: "var-3f9a", name: "好感度" },
  { id: "day", name: "天数" },
];

test("shows variables by name", () => {
  assert.equal(templateToDisplay("好感 {{var-3f9a}} · 第{{ day }}天", vars), "好感 {{好感度}} · 第{{天数}}天");
});

test("writes names back as ids", () => {
  assert.equal(templateFromDisplay("好感 {{好感度}} · 第{{天数}}天", vars), "好感 {{var-3f9a}} · 第{{day}}天");
});

test("round-trips and leaves unknown macros alone", () => {
  const src = "{{item.name}} {{user}} {{var-3f9a}} {{nope}}";
  assert.equal(templateFromDisplay(templateToDisplay(src, vars), vars), src);
  assert.equal(templateToDisplay(src, vars), "{{item.name}} {{user}} {{好感度}} {{nope}}");
});

test("an id typed directly still counts", () => {
  assert.equal(templateFromDisplay("{{day}}", vars), "{{day}}");
});
