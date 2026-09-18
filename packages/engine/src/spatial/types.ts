/**
 * Spatial System — Data model for scenes, zones, entities, and exits.
 *
 * A Scene is a discrete area in the game world (a room, a forest clearing,
 * a town square). Scenes contain Zones (named regions), Entities (NPCs,
 * objects), and Exits (connections to other scenes).
 *
 * The player exists in one scene at a time, at a grid position (x, y).
 * Movement, zone detection, and proximity checks happen client-side.
 * Events are emitted when spatial state changes (entering zones, nearing
 * entities, changing scenes).
 */

/** A discrete area in the game world */
export interface Scene {
  id: string;
  name: string;
  /** Description for AI context — tells the AI what this place is */
  description: string;
  /** Grid width in tiles */
  width: number;
  /** Grid height in tiles */
  height: number;
  /** Background image URL (fills the scene view) */
  background?: string;
  /** Named rectangular regions within the scene */
  zones: Zone[];
  /** NPCs, objects, and interactables placed in the scene */
  entities: SceneEntity[];
  /** Connections to other scenes */
  exits: SceneExit[];
  /** Tile data for rendering (optional — scenes can be image-only) */
  tileData?: number[][];
  /** Ambient audio track ID to play in this scene */
  ambientAudio?: string;
}

/** A named rectangular region within a scene */
export interface Zone {
  id: string;
  name: string;
  /** Description for AI context */
  description?: string;
  /** Top-left X position (grid units) */
  x: number;
  /** Top-left Y position (grid units) */
  y: number;
  /** Width (grid units) */
  width: number;
  /** Height (grid units) */
  height: number;
  /** Color for editor visualization */
  color?: string;
  /** Tags for categorization */
  tags?: string[];
}

/** An entity placed in a scene (NPC, object, interactable) */
export interface SceneEntity {
  id: string;
  name: string;
  type: "npc" | "object" | "interactable";
  /** Grid X position */
  x: number;
  /** Grid Y position */
  y: number;
  /** Sprite/image URL */
  sprite?: string;
  /** Description for AI context */
  description?: string;
  /** Radius (in grid units) within which the player can interact. Default 1.5 */
  interactRadius?: number;
  /** Linked entry IDs — enabled when player is in proximity */
  linkedEntryIds?: string[];
  /** Linked reaction IDs — fired on interact */
  linkedReactionIds?: string[];
}

/** A connection from one scene to another */
export interface SceneExit {
  id: string;
  /** Scene to transition to */
  targetSceneId: string;
  /** Grid position of the exit area */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Cardinal direction label (for AI context) */
  direction?: string;
  /** Description for AI context */
  description?: string;
  /** Conditions that must be true to use this exit */
  conditionVariableId?: string;
  conditionValue?: unknown;
}

/** Current spatial state tracked at runtime */
export interface SpatialState {
  /** Active scene ID */
  sceneId: string;
  /** Player grid position */
  playerX: number;
  playerY: number;
  /** Player facing direction */
  playerFacing: "up" | "down" | "left" | "right";
  /** Current zone the player is in (null if not in any zone) */
  currentZoneId: string | null;
  /** Entity IDs currently in proximity */
  nearbyEntityIds: string[];
}
