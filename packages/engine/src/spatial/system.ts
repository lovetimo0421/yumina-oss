import type { SystemDefinition } from "../systems/types.js";

/** Spatial System — scenes, zones, entities, player movement */
export const SPATIAL_SYSTEM: SystemDefinition = {
  id: "spatial",
  name: "Spatial World",
  description: "Tile-based scenes with zones, entities, exits, and player movement",
  category: "Gameplay",
  alwaysActive: false,
  events: [
    {
      type: "spatial:zone-enter",
      description: "Player entered a named zone in the scene",
      dataFields: [
        { name: "zoneId", type: "string", description: "Zone ID" },
        { name: "zoneName", type: "string", description: "Zone name" },
        { name: "fromZoneId", type: "string", description: "Previous zone ID (null if none)" },
      ],
    },
    {
      type: "spatial:zone-leave",
      description: "Player left a named zone in the scene",
      dataFields: [
        { name: "zoneId", type: "string", description: "Zone ID" },
        { name: "zoneName", type: "string", description: "Zone name" },
        { name: "toZoneId", type: "string", description: "Next zone ID (null if none)" },
      ],
    },
    {
      type: "spatial:proximity-enter",
      description: "Player entered proximity range of an entity",
      dataFields: [
        { name: "entityId", type: "string", description: "Entity ID" },
        { name: "entityName", type: "string", description: "Entity name" },
        { name: "entityType", type: "string", description: "Entity type (npc, object, interactable)" },
        { name: "distance", type: "number", description: "Distance in grid units" },
      ],
    },
    {
      type: "spatial:proximity-leave",
      description: "Player left proximity range of an entity",
      dataFields: [
        { name: "entityId", type: "string", description: "Entity ID" },
        { name: "entityName", type: "string", description: "Entity name" },
      ],
    },
    {
      type: "spatial:interact",
      description: "Player interacted with a nearby entity",
      dataFields: [
        { name: "entityId", type: "string", description: "Entity ID" },
        { name: "entityName", type: "string", description: "Entity name" },
        { name: "entityType", type: "string", description: "Entity type" },
        { name: "distance", type: "number", description: "Distance when interacted" },
      ],
    },
    {
      type: "spatial:scene-change",
      description: "Player moved to a different scene",
      dataFields: [
        { name: "sceneId", type: "string", description: "New scene ID" },
        { name: "sceneName", type: "string", description: "New scene name" },
        { name: "fromSceneId", type: "string", description: "Previous scene ID" },
      ],
    },
    {
      type: "spatial:exit-overlap",
      description: "Player stepped onto a scene exit",
      dataFields: [
        { name: "exitId", type: "string", description: "Exit ID" },
        { name: "targetSceneId", type: "string", description: "Target scene ID" },
        { name: "targetSceneName", type: "string", description: "Target scene name" },
        { name: "direction", type: "string", description: "Exit direction (north, south, etc.)" },
      ],
    },
  ],
  statePaths: [
    { path: "@scene.current", description: "Current scene ID", valueType: "string" },
    { path: "@scene.player.x", description: "Player X position (grid units)", valueType: "number" },
    { path: "@scene.player.y", description: "Player Y position (grid units)", valueType: "number" },
    { path: "@scene.player.zone", description: "Current zone ID (null if none)", valueType: "string" },
    { path: "@scene.player.facing", description: "Player facing direction (up/down/left/right)", valueType: "string" },
  ],
};
