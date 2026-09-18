import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../events/event-bus.js";

describe("EventBus", () => {
  it("delivers events to exact type subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("message:user", handler);
    bus.emit({ type: "message:user", content: "hello" });
    expect(handler).toHaveBeenCalledWith({ type: "message:user", content: "hello" });
  });

  it("does not deliver events to non-matching subscribers", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("message:ai", handler);
    bus.emit({ type: "message:user", content: "hello" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("supports wildcard subscriptions", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on("spatial:*", handler);

    bus.emit({ type: "spatial:zone-enter", zone: "forest" });
    bus.emit({ type: "spatial:proximity-enter", entityId: "npc_01" });
    bus.emit({ type: "message:user", content: "hello" });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith({ type: "spatial:zone-enter", zone: "forest" });
    expect(handler).toHaveBeenCalledWith({ type: "spatial:proximity-enter", entityId: "npc_01" });
  });

  it("returns an unsubscribe function", () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.on("test:event", handler);

    bus.emit({ type: "test:event" });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.emit({ type: "test:event" });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("supports multiple subscribers for the same event", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("test:event", h1);
    bus.on("test:event", h2);

    bus.emit({ type: "test:event" });
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it("clear() removes all handlers", () => {
    const bus = new EventBus();
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on("a", h1);
    bus.on("b:*", h2);

    bus.clear();
    bus.emit({ type: "a" });
    bus.emit({ type: "b:test" });

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });
});
