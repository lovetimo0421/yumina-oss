/**
 * Building blocks.
 *
 * Platform-maintained React components that handle complex infrastructure
 * (scroll, streaming, input handling). Creators import and use them
 * inside their root component.
 *
 * Simple UI (stat bars, badges, panels) — creators write their own.
 * These building blocks only exist for things that are genuinely hard
 * to build correctly (chat experience, message scrolling, text input).
 */

// High-level compound component — the full chat experience
export { Chat } from "./chat";

// The people at a story room's table, for a card that draws its own screen.
export { RoomParty } from "./room-party";
export type { RoomPartyProps } from "./room-party";
export type { ChatProps, BubbleProps } from "./chat";

// Granular chat components — for when <Chat> is too constraining
export { MessageList } from "../chat/message-list";
export { MessageInput } from "../chat/message-input";

// Model switcher — drop into custom UIs so players can change model in-game
// without leaving the chat (the official chat composer already includes
// <ModelTrigger>; cards with custom rootComponent must wire it themselves).
export { ModelPickerModal, ModelTrigger } from "../chat/model-picker-modal";

// Session memory — same modal as the official chat composer Context button.
// Requires the session-memory-summary extension (api.memorySummaryEnabled).
export { SessionMemoryModal } from "../extensions/session-memory/session-memory-modal";

// A live character from one picture (a .rig6 pack): breathes, blinks, talks, reacts.
export { RigCharacter } from "./rig-character";
export type { RigCharacterProps, RigControls, RigCue, RigMood } from "./rig-character";
