import { describe, it, expect } from "vitest";
import { TimerRuntime } from "../timer/runtime.js";

describe("TimerRuntime", () => {
  describe("basic timer", () => {
    it("creates and starts a timer", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb Timer", 10);
      const timer = rt.getTimer("bomb");
      expect(timer).toBeDefined();
      expect(timer!.duration).toBe(10);
      expect(timer!.remaining).toBe(10);
      expect(timer!.active).toBe(true);
    });

    it("counts down on tick", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb Timer", 10);
      rt.tick(3);
      expect(rt.getTimer("bomb")!.remaining).toBeCloseTo(7);
    });

    it("fires when reaching zero", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb Timer", 5);
      const events1 = rt.tick(3);
      expect(events1).toHaveLength(0);

      const events2 = rt.tick(3); // past zero
      expect(events2).toHaveLength(1);
      expect(events2[0]!.type).toBe("timer:fired");
      expect(events2[0]!.timerId).toBe("bomb");
      expect(events2[0]!.timerName).toBe("Bomb Timer");
    });

    it("removes one-shot timer after firing", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb Timer", 1);
      rt.tick(2);
      expect(rt.getTimer("bomb")).toBeUndefined();
    });
  });

  describe("repeating timer", () => {
    it("resets after firing", () => {
      const rt = new TimerRuntime();
      rt.start("heartbeat", "Heartbeat", 2, true);

      const events1 = rt.tick(2.5); // fires at 2, remaining resets
      expect(events1).toHaveLength(1);
      expect(events1[0]!.timerId).toBe("heartbeat");

      const timer = rt.getTimer("heartbeat");
      expect(timer).toBeDefined();
      expect(timer!.active).toBe(true);
      // Remaining should be duration - overshoot: 2 - 0.5 = 1.5
      expect(timer!.remaining).toBeCloseTo(1.5);
    });

    it("fires multiple times", () => {
      const rt = new TimerRuntime();
      rt.start("pulse", "Pulse", 1, true);

      rt.tick(1.5); // fires once
      const timer = rt.getTimer("pulse");
      expect(timer!.remaining).toBeCloseTo(0.5);

      const events = rt.tick(0.6); // fires again
      expect(events).toHaveLength(1);
    });
  });

  describe("pause and resume", () => {
    it("stops counting when paused", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb", 10);
      rt.tick(3);
      expect(rt.getTimer("bomb")!.remaining).toBeCloseTo(7);

      rt.pause("bomb");
      rt.tick(5); // should not count down
      expect(rt.getTimer("bomb")!.remaining).toBeCloseTo(7);
    });

    it("resumes counting after unpause", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb", 10);
      rt.tick(3);
      rt.pause("bomb");
      rt.tick(5);
      rt.resume("bomb");
      rt.tick(2);
      expect(rt.getTimer("bomb")!.remaining).toBeCloseTo(5);
    });
  });

  describe("cancel", () => {
    it("removes a timer", () => {
      const rt = new TimerRuntime();
      rt.start("bomb", "Bomb", 10);
      rt.cancel("bomb");
      expect(rt.getTimer("bomb")).toBeUndefined();
    });

    it("cancelAll removes all timers", () => {
      const rt = new TimerRuntime();
      rt.start("a", "A", 10);
      rt.start("b", "B", 20);
      rt.cancelAll();
      expect(rt.getState().timers).toHaveLength(0);
    });
  });

  describe("multiple timers", () => {
    it("ticks all active timers independently", () => {
      const rt = new TimerRuntime();
      rt.start("fast", "Fast", 2);
      rt.start("slow", "Slow", 5);

      const events1 = rt.tick(2.5);
      expect(events1).toHaveLength(1);
      expect(events1[0]!.timerId).toBe("fast");

      const events2 = rt.tick(3);
      expect(events2).toHaveLength(1);
      expect(events2[0]!.timerId).toBe("slow");
    });
  });

  describe("initialization", () => {
    it("accepts initial timers", () => {
      const rt = new TimerRuntime([
        { id: "a", name: "A", duration: 10, remaining: 5, repeat: false, active: true, paused: false },
      ]);
      expect(rt.getTimer("a")!.remaining).toBe(5);
    });
  });

  describe("getState", () => {
    it("returns snapshot of all timers", () => {
      const rt = new TimerRuntime();
      rt.start("a", "A", 10);
      rt.start("b", "B", 20, true);
      const state = rt.getState();
      expect(state.timers).toHaveLength(2);
      expect(state.timers.find((t) => t.id === "a")!.duration).toBe(10);
      expect(state.timers.find((t) => t.id === "b")!.repeat).toBe(true);
    });
  });
});
