import { describe, it, expect } from "vitest";
import { addMeterRow } from "../edit.js";
import { DESKTOP_CHAT_COLUMN_W, withDesktopConversation } from "../desktop-conversation.js";
import { UI_DESKTOP_W } from "../types.js";
import type { UiDoc } from "../types.js";

// A bare chat made into a page, the way putting a value on screen makes one.
const chat = (): UiDoc => ({
  version: 1,
  entryPageId: "p",
  pages: [{
    id: "p",
    name: "Chat",
    height: 812,
    elements: [
      { id: "m", type: "messages", name: "Transcript", x: 0, y: 0, w: 375, h: 704 },
      { id: "c", type: "composer", name: "Input", x: 0, y: 716, w: 375, h: 96 },
    ],
  }],
}) as UiDoc;

const left = (UI_DESKTOP_W - DESKTOP_CHAT_COLUMN_W) / 2;

describe("values put on the player screen, on a desktop", () => {
  it("keep the conversation in its centred column, with their rows above it", () => {
    let doc = addMeterRow(chat(), "p", { id: "a", label: "好感度", variableId: "affection" });
    doc = addMeterRow(doc, "p", { id: "b", label: "金钱", variableId: "gold" });
    const elements = doc.pages[0]!.elements;
    const transcript = elements.find((el) => el.id === "m")!;
    expect(transcript.desktop).toMatchObject({ x: left, w: DESKTOP_CHAT_COLUMN_W });
    for (const id of ["a", "b"]) {
      const meter = elements.find((el) => el.id === id)!;
      expect(meter.desktop!.x).toBeGreaterThanOrEqual(left);
      expect(meter.desktop!.x + meter.desktop!.w).toBeLessThanOrEqual(left + DESKTOP_CHAT_COLUMN_W);
      expect(meter.desktop!.y + meter.desktop!.h).toBeLessThanOrEqual(transcript.desktop!.y);
    }
  });

  it("repairs a conversation whose wide box was only the phone's copied over", () => {
    const page = chat().pages[0]!;
    page.elements[0] = { ...page.elements[0]!, y: 100, h: 604, desktop: { x: 0, y: 100, w: 375, h: 604 } };
    const fixed = withDesktopConversation(page).elements.find((el) => el.id === "m")!;
    expect(fixed.desktop).toMatchObject({ x: left, w: DESKTOP_CHAT_COLUMN_W });
  });

  it("leaves a conversation the card placed on the desktop where it is", () => {
    const page = chat().pages[0]!;
    page.elements[0] = { ...page.elements[0]!, desktop: { x: 300, y: 0, w: 600, h: 500 } };
    expect(withDesktopConversation(page).elements[0]!.desktop).toEqual({ x: 300, y: 0, w: 600, h: 500 });
  });
});
