import { describe, it, expect } from "vitest";
import { SpatialRuntime } from "../spatial/runtime.js";
import type { Scene } from "../spatial/types.js";

const VILLAGE: Scene = {
  id: "village",
  name: "The Village",
  description: "A peaceful village with cobblestone streets.",
  width: 20,
  height: 20,
  zones: [
    { id: "market", name: "Market Square", description: "Bustling marketplace", x: 5, y: 5, width: 5, height: 5 },
    { id: "garden", name: "Village Garden", description: "Quiet garden", x: 12, y: 2, width: 4, height: 4 },
  ],
  entities: [
    { id: "merchant", name: "Merchant", type: "npc", x: 7, y: 7, description: "A friendly trader", interactRadius: 1.5 },
    { id: "well", name: "Stone Well", type: "object", x: 10, y: 10, interactRadius: 1.0 },
    { id: "guard", name: "Village Guard", type: "npc", x: 2, y: 2, interactRadius: 2.0 },
  ],
  exits: [
    { id: "north_exit", targetSceneId: "forest", x: 9, y: 0, width: 2, height: 1, direction: "north" },
  ],
};

const FOREST: Scene = {
  id: "forest",
  name: "Dark Forest",
  description: "Ancient trees block out the sunlight.",
  width: 30,
  height: 30,
  zones: [
    { id: "clearing", name: "Forest Clearing", x: 10, y: 10, width: 5, height: 5 },
  ],
  entities: [
    { id: "spirit", name: "Forest Spirit", type: "npc", x: 12, y: 12, interactRadius: 2.0 },
  ],
  exits: [
    { id: "south_exit", targetSceneId: "village", x: 14, y: 29, width: 2, height: 1, direction: "south" },
  ],
};

describe("SpatialRuntime", () => {
  describe("initialization", () => {
    it("initializes with the first scene", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST]);
      const state = runtime.getState();
      expect(state.sceneId).toBe("village");
      expect(state.playerX).toBe(10); // center of 20
      expect(state.playerY).toBe(10);
    });

    it("accepts a specific starting scene and position", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "forest", 5, 5);
      const state = runtime.getState();
      expect(state.sceneId).toBe("forest");
      expect(state.playerX).toBe(5);
      expect(state.playerY).toBe(5);
    });

    it("detects starting zone if spawned inside one", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 7, 7);
      expect(runtime.getState().currentZoneId).toBe("market");
    });
  });

  describe("movement", () => {
    it("moves player by delta", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 10, 10);
      runtime.move(1, 0);
      expect(runtime.getState().playerX).toBe(11);
      expect(runtime.getState().playerFacing).toBe("right");
    });

    it("prevents movement out of bounds", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 0, 0);
      const events = runtime.move(-1, 0);
      expect(runtime.getState().playerX).toBe(0);
      expect(events).toHaveLength(0);
    });

    it("updates facing direction", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 10, 10);
      runtime.move(0, -1);
      expect(runtime.getState().playerFacing).toBe("up");
      runtime.move(-1, 0);
      expect(runtime.getState().playerFacing).toBe("left");
      runtime.move(0, 1);
      expect(runtime.getState().playerFacing).toBe("down");
    });
  });

  describe("zone detection", () => {
    it("emits zone-enter when walking into a zone", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 4, 7);
      const events = runtime.move(1, 0); // x=5, entering market zone
      const enter = events.find((e) => e.type === "spatial:zone-enter");
      expect(enter).toBeDefined();
      expect(enter!.zoneId).toBe("market");
      expect(enter!.zoneName).toBe("Market Square");
      expect(runtime.getState().currentZoneId).toBe("market");
    });

    it("emits zone-leave when walking out of a zone", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 5, 7);
      expect(runtime.getState().currentZoneId).toBe("market");

      const events = runtime.move(-1, 0); // x=4, leaving market
      const leave = events.find((e) => e.type === "spatial:zone-leave");
      expect(leave).toBeDefined();
      expect(leave!.zoneId).toBe("market");
      expect(runtime.getState().currentZoneId).toBeNull();
    });

    it("emits both leave and enter when moving between zones", () => {
      // Place a second zone adjacent to market for testing
      const scene: Scene = {
        ...VILLAGE,
        zones: [
          ...VILLAGE.zones,
          { id: "alley", name: "Dark Alley", x: 10, y: 5, width: 3, height: 5 },
        ],
      };
      const runtime = new SpatialRuntime([scene], "village", 9, 7);
      expect(runtime.getState().currentZoneId).toBe("market");

      const events = runtime.move(1, 0); // x=10, entering alley
      expect(events.some((e) => e.type === "spatial:zone-leave" && e.zoneId === "market")).toBe(true);
      expect(events.some((e) => e.type === "spatial:zone-enter" && e.zoneId === "alley")).toBe(true);
    });

    it("does not emit events when moving within the same zone", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 6, 7);
      expect(runtime.getState().currentZoneId).toBe("market");

      const events = runtime.move(1, 0); // x=7, still in market
      expect(events.filter((e) => e.type === "spatial:zone-enter" || e.type === "spatial:zone-leave")).toHaveLength(0);
    });
  });

  describe("entity proximity", () => {
    it("emits proximity-enter when approaching an entity", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 5, 7);
      // Merchant is at (7,7), interact radius 1.5, proximity = 3.0
      // Distance from (5,7) to (7,7) = 2, within proximity (3.0)
      const events = runtime.move(1, 0); // x=6, distance to merchant = 1
      const enter = events.find(
        (e) => e.type === "spatial:proximity-enter" && e.entityId === "merchant"
      );
      // At (6,7) distance to merchant (7,7) = 1.0, within proximity radius (1.5*2=3)
      expect(enter).toBeDefined();
    });

    it("emits proximity-leave when moving away from an entity", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 6, 7);
      // Move to (7,7) to enter merchant proximity
      runtime.move(1, 0);
      expect(runtime.getState().nearbyEntityIds).toContain("merchant");

      // Move far away — setPosition returns events including proximity-leave
      const moveEvents = runtime.setPosition(19, 19);
      const leave = moveEvents.find(
        (e) => e.type === "spatial:proximity-leave" && e.entityId === "merchant"
      );
      expect(leave).toBeDefined();
      expect(runtime.getState().nearbyEntityIds).not.toContain("merchant");
    });
  });

  describe("interaction", () => {
    it("returns interact event when near an entity", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 7, 7);
      const events = runtime.interact();
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe("spatial:interact");
      expect(events[0]!.entityId).toBe("merchant");
    });

    it("returns empty when no entity in range", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 15, 15);
      const events = runtime.interact();
      expect(events).toHaveLength(0);
    });

    it("picks the nearest entity when multiple are in range", () => {
      // Place player between merchant (7,7) and well (10,10)
      const runtime = new SpatialRuntime([VILLAGE], "village", 7, 8);
      const events = runtime.interact();
      // Merchant at (7,7) is 1 tile away, well at (10,10) is ~3.6 tiles
      expect(events[0]!.entityId).toBe("merchant");
    });
  });

  describe("scene transitions", () => {
    it("changes scene and emits scene-change event", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "village", 10, 10);
      const events = runtime.changeScene("forest", 15, 15);

      const change = events.find((e) => e.type === "spatial:scene-change");
      expect(change).toBeDefined();
      expect(change!.sceneId).toBe("forest");
      expect(change!.fromSceneId).toBe("village");

      const state = runtime.getState();
      expect(state.sceneId).toBe("forest");
      expect(state.playerX).toBe(15);
      expect(state.playerY).toBe(15);
    });

    it("emits zone-leave for current zone on scene change", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "village", 7, 7);
      expect(runtime.getState().currentZoneId).toBe("market");

      const events = runtime.changeScene("forest");
      expect(events.some((e) => e.type === "spatial:zone-leave" && e.zoneId === "market")).toBe(true);
    });

    it("detects new zone in target scene", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "village", 10, 10);
      runtime.changeScene("forest", 12, 12); // Inside forest clearing zone
      expect(runtime.getState().currentZoneId).toBe("clearing");
    });
  });

  describe("exit detection", () => {
    it("emits exit-overlap when player steps on an exit", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "village", 9, 1);
      const events = runtime.move(0, -1); // y=0, on the north exit
      const exitEvent = events.find((e) => e.type === "spatial:exit-overlap");
      expect(exitEvent).toBeDefined();
      expect(exitEvent!.targetSceneId).toBe("forest");
    });
  });

  describe("context building", () => {
    it("builds context string with scene info", () => {
      const runtime = new SpatialRuntime([VILLAGE, FOREST], "village", 6, 7);
      // Move into market zone + trigger proximity to merchant
      runtime.move(1, 0); // x=7, y=7
      const ctx = runtime.buildContext();
      expect(ctx).toContain("The Village");
      expect(ctx).toContain("Market Square");
      expect(ctx).toContain("Merchant");
      expect(ctx).toContain("Exits:");
    });

    it("includes nearby entities with distance", () => {
      const runtime = new SpatialRuntime([VILLAGE], "village", 6, 7);
      runtime.move(1, 0); // move to (7,7), near merchant
      const ctx = runtime.buildContext();
      expect(ctx).toContain("Merchant");
      expect(ctx).toContain("npc");
    });
  });
});
