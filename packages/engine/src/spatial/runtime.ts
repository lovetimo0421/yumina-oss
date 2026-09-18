import type { Scene, Zone, SceneEntity, SpatialState } from "./types.js";
import type { GameEvent } from "../events/types.js";

/**
 * SpatialRuntime — Pure logic for spatial state management.
 *
 * Tracks player position within a scene, detects zone transitions,
 * entity proximity changes, and exit overlaps. Emits GameEvents
 * for the ReactionEvaluator to process.
 *
 * Framework-agnostic — no DOM, no Canvas, no React. Rendering is
 * handled by the app layer; this class handles only the game logic.
 */
export class SpatialRuntime {
  private scenes: Map<string, Scene>;
  private state: SpatialState;

  constructor(scenes: Scene[], initialSceneId?: string, initialX?: number, initialY?: number) {
    this.scenes = new Map(scenes.map((s) => [s.id, s]));

    const firstScene = scenes[0];
    this.state = {
      sceneId: initialSceneId ?? firstScene?.id ?? "",
      playerX: initialX ?? Math.floor((firstScene?.width ?? 10) / 2),
      playerY: initialY ?? Math.floor((firstScene?.height ?? 10) / 2),
      playerFacing: "down",
      currentZoneId: null,
      nearbyEntityIds: [],
    };

    // Initialize current zone
    const scene = this.getCurrentScene();
    if (scene) {
      this.state.currentZoneId = this.findZoneAt(scene, this.state.playerX, this.state.playerY)?.id ?? null;
    }
  }

  /** Get the current spatial state (readonly snapshot) */
  getState(): Readonly<SpatialState> {
    return { ...this.state, nearbyEntityIds: [...this.state.nearbyEntityIds] };
  }

  /** Get the current scene definition */
  getCurrentScene(): Scene | undefined {
    return this.scenes.get(this.state.sceneId);
  }

  /** Get a scene by ID */
  getScene(id: string): Scene | undefined {
    return this.scenes.get(id);
  }

  /** Get all scenes */
  getAllScenes(): Scene[] {
    return [...this.scenes.values()];
  }

  /**
   * Move the player by a delta and return any events triggered.
   * This is the main method called by the game loop on each frame.
   *
   * @param dx - Horizontal movement (-1, 0, or 1)
   * @param dy - Vertical movement (-1, 0, or 1)
   * @returns Array of GameEvents triggered by this movement
   */
  move(dx: number, dy: number): GameEvent[] {
    const scene = this.getCurrentScene();
    if (!scene) return [];

    const newX = this.state.playerX + dx;
    const newY = this.state.playerY + dy;

    // Bounds check
    if (newX < 0 || newX >= scene.width || newY < 0 || newY >= scene.height) {
      return [];
    }

    // Update facing direction
    if (dx > 0) this.state.playerFacing = "right";
    else if (dx < 0) this.state.playerFacing = "left";
    else if (dy > 0) this.state.playerFacing = "down";
    else if (dy < 0) this.state.playerFacing = "up";

    // Update position
    this.state.playerX = newX;
    this.state.playerY = newY;

    // Collect events from state changes
    const events: GameEvent[] = [];

    // Check zone transitions
    events.push(...this.checkZoneTransition(scene));

    // Check entity proximity changes
    events.push(...this.checkProximityChanges(scene));

    // Check exit overlaps
    events.push(...this.checkExitOverlap(scene));

    return events;
  }

  /**
   * Set the player position directly (e.g., after scene transition).
   * Returns events triggered at the new position.
   */
  setPosition(x: number, y: number): GameEvent[] {
    const scene = this.getCurrentScene();
    if (!scene) return [];

    this.state.playerX = Math.max(0, Math.min(scene.width - 1, x));
    this.state.playerY = Math.max(0, Math.min(scene.height - 1, y));

    const events: GameEvent[] = [];
    events.push(...this.checkZoneTransition(scene));
    events.push(...this.checkProximityChanges(scene));
    return events;
  }

  /**
   * Transition to a different scene.
   * Returns events triggered by the scene change + initial position.
   */
  changeScene(sceneId: string, spawnX?: number, spawnY?: number): GameEvent[] {
    const newScene = this.scenes.get(sceneId);
    if (!newScene) return [];

    const fromSceneId = this.state.sceneId;
    const fromZoneId = this.state.currentZoneId;

    // Leave current zone
    const events: GameEvent[] = [];
    if (fromZoneId) {
      const oldScene = this.getCurrentScene();
      const oldZone = oldScene?.zones.find((z) => z.id === fromZoneId);
      events.push({
        type: "spatial:zone-leave",
        zoneId: fromZoneId,
        zoneName: oldZone?.name ?? "",
        toZoneId: null,
      });
    }

    // Clear nearby entities
    for (const entityId of this.state.nearbyEntityIds) {
      const oldScene = this.getCurrentScene();
      const entity = oldScene?.entities.find((e) => e.id === entityId);
      events.push({
        type: "spatial:proximity-leave",
        entityId,
        entityName: entity?.name ?? "",
      });
    }

    // Update state
    this.state.sceneId = sceneId;
    this.state.playerX = spawnX ?? Math.floor(newScene.width / 2);
    this.state.playerY = spawnY ?? Math.floor(newScene.height / 2);
    this.state.currentZoneId = null;
    this.state.nearbyEntityIds = [];

    // Emit scene change
    events.push({
      type: "spatial:scene-change",
      sceneId,
      sceneName: newScene.name,
      fromSceneId,
    });

    // Check new zone + proximity
    events.push(...this.checkZoneTransition(newScene));
    events.push(...this.checkProximityChanges(newScene));

    return events;
  }

  /**
   * Trigger an interact event for the nearest entity within interact range.
   * Called when the player presses the interact key.
   * Returns the interact event, or empty if no entity is in range.
   */
  interact(): GameEvent[] {
    const scene = this.getCurrentScene();
    if (!scene) return [];

    // Find the nearest interactable entity within range
    let nearest: { entity: SceneEntity; distance: number } | null = null;

    for (const entity of scene.entities) {
      const dist = Math.hypot(entity.x - this.state.playerX, entity.y - this.state.playerY);
      const radius = entity.interactRadius ?? 1.5;

      if (dist <= radius) {
        if (!nearest || dist < nearest.distance) {
          nearest = { entity, distance: dist };
        }
      }
    }

    if (!nearest) return [];

    return [{
      type: "spatial:interact",
      entityId: nearest.entity.id,
      entityName: nearest.entity.name,
      entityType: nearest.entity.type,
      distance: nearest.distance,
    }];
  }

  /**
   * Build a context description of the current spatial state.
   * Used by the PromptBuilder to give the AI spatial awareness.
   */
  buildContext(): string {
    const scene = this.getCurrentScene();
    if (!scene) return "";

    const parts: string[] = [];
    parts.push(`Location: ${scene.name}`);
    if (scene.description) parts.push(scene.description);

    // Current zone
    const zone = scene.zones.find((z) => z.id === this.state.currentZoneId);
    if (zone) {
      parts.push(`Area: ${zone.name}${zone.description ? ` — ${zone.description}` : ""}`);
    }

    // Nearby entities
    const nearby = this.state.nearbyEntityIds
      .map((id) => scene.entities.find((e) => e.id === id))
      .filter(Boolean) as SceneEntity[];

    if (nearby.length > 0) {
      const entityDescs = nearby.map((e) => {
        const dist = Math.hypot(e.x - this.state.playerX, e.y - this.state.playerY).toFixed(1);
        return `${e.name} (${e.type}, ${dist} tiles away)${e.description ? `: ${e.description}` : ""}`;
      });
      parts.push(`Nearby: ${entityDescs.join("; ")}`);
    }

    // Exits
    if (scene.exits.length > 0) {
      const exitDescs = scene.exits.map((exit) => {
        const target = this.scenes.get(exit.targetSceneId);
        const dir = exit.direction ? `${exit.direction} → ` : "";
        return `${dir}${target?.name ?? exit.targetSceneId}`;
      });
      parts.push(`Exits: ${exitDescs.join(", ")}`);
    }

    return parts.join("\n");
  }

  // ── Private helpers ──

  /** Find which zone (if any) contains the given position */
  private findZoneAt(scene: Scene, x: number, y: number): Zone | null {
    for (const zone of scene.zones) {
      if (x >= zone.x && x < zone.x + zone.width &&
          y >= zone.y && y < zone.y + zone.height) {
        return zone;
      }
    }
    return null;
  }

  /** Check if player moved to a different zone, emit events */
  private checkZoneTransition(scene: Scene): GameEvent[] {
    const events: GameEvent[] = [];
    const newZone = this.findZoneAt(scene, this.state.playerX, this.state.playerY);
    const newZoneId = newZone?.id ?? null;

    if (newZoneId !== this.state.currentZoneId) {
      // Leave old zone
      if (this.state.currentZoneId) {
        const oldZone = scene.zones.find((z) => z.id === this.state.currentZoneId);
        events.push({
          type: "spatial:zone-leave",
          zoneId: this.state.currentZoneId,
          zoneName: oldZone?.name ?? "",
          toZoneId: newZoneId,
        });
      }

      // Enter new zone
      if (newZoneId && newZone) {
        events.push({
          type: "spatial:zone-enter",
          zoneId: newZoneId,
          zoneName: newZone.name,
          fromZoneId: this.state.currentZoneId,
        });
      }

      this.state.currentZoneId = newZoneId;
    }

    return events;
  }

  /** Check entity proximity changes, emit events */
  private checkProximityChanges(scene: Scene): GameEvent[] {
    const events: GameEvent[] = [];
    const newNearby = new Set<string>();

    for (const entity of scene.entities) {
      const dist = Math.hypot(entity.x - this.state.playerX, entity.y - this.state.playerY);
      const radius = entity.interactRadius ?? 1.5;
      // Proximity detection uses a slightly larger radius than interact
      const proximityRadius = radius * 2;

      if (dist <= proximityRadius) {
        newNearby.add(entity.id);

        // New proximity — wasn't nearby before
        if (!this.state.nearbyEntityIds.includes(entity.id)) {
          events.push({
            type: "spatial:proximity-enter",
            entityId: entity.id,
            entityName: entity.name,
            entityType: entity.type,
            distance: dist,
          });
        }
      }
    }

    // Left proximity — was nearby, no longer
    for (const entityId of this.state.nearbyEntityIds) {
      if (!newNearby.has(entityId)) {
        const entity = scene.entities.find((e) => e.id === entityId);
        events.push({
          type: "spatial:proximity-leave",
          entityId,
          entityName: entity?.name ?? "",
        });
      }
    }

    this.state.nearbyEntityIds = [...newNearby];
    return events;
  }

  /** Check if player is overlapping an exit, emit event */
  private checkExitOverlap(scene: Scene): GameEvent[] {
    const events: GameEvent[] = [];
    const { playerX, playerY } = this.state;

    for (const exit of scene.exits) {
      if (playerX >= exit.x && playerX < exit.x + exit.width &&
          playerY >= exit.y && playerY < exit.y + exit.height) {
        const target = this.scenes.get(exit.targetSceneId);
        events.push({
          type: "spatial:exit-overlap",
          exitId: exit.id,
          targetSceneId: exit.targetSceneId,
          targetSceneName: target?.name ?? "",
          direction: exit.direction,
        });
        break; // Only one exit at a time
      }
    }

    return events;
  }
}
