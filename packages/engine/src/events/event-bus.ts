import type { GameEvent, EventHandler } from "./types.js";

/**
 * Simple pub/sub event bus for GameEvents.
 * Supports exact type matching and trailing wildcard ("spatial:*").
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private wildcardHandlers = new Map<string, Set<EventHandler>>();

  /** Subscribe to events matching a pattern. Returns an unsubscribe function. */
  on(pattern: string, handler: EventHandler): () => void {
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -1); // "spatial:" from "spatial:*"
      let set = this.wildcardHandlers.get(prefix);
      if (!set) {
        set = new Set();
        this.wildcardHandlers.set(prefix, set);
      }
      set.add(handler);
      return () => {
        set!.delete(handler);
        if (set!.size === 0) this.wildcardHandlers.delete(prefix);
      };
    }

    let set = this.handlers.get(pattern);
    if (!set) {
      set = new Set();
      this.handlers.set(pattern, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(pattern);
    };
  }

  /** Emit an event to all matching subscribers. */
  emit(event: GameEvent): void {
    // Exact match
    const exact = this.handlers.get(event.type);
    if (exact) {
      for (const handler of exact) handler(event);
    }

    // Wildcard match — check all registered prefixes
    for (const [prefix, handlers] of this.wildcardHandlers) {
      if (event.type.startsWith(prefix)) {
        for (const handler of handlers) handler(event);
      }
    }
  }

  /** Remove all handlers. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
  }
}
