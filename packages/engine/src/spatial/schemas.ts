import { z } from "zod";

export const zoneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  x: z.number(),
  y: z.number(),
  width: z.number().min(1),
  height: z.number().min(1),
  color: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const sceneEntitySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  type: z.enum(["npc", "object", "interactable"]),
  x: z.number(),
  y: z.number(),
  sprite: z.string().optional(),
  description: z.string().optional(),
  interactRadius: z.number().min(0).optional(),
  linkedEntryIds: z.array(z.string()).optional(),
  linkedReactionIds: z.array(z.string()).optional(),
});

export const sceneExitSchema = z.object({
  id: z.string(),
  targetSceneId: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number().min(1),
  height: z.number().min(1),
  direction: z.string().optional(),
  description: z.string().optional(),
  conditionVariableId: z.string().optional(),
  conditionValue: z.unknown().optional(),
});

export const sceneSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  width: z.number().int().min(1).max(1000),
  height: z.number().int().min(1).max(1000),
  background: z.string().optional(),
  zones: z.array(zoneSchema).default([]),
  entities: z.array(sceneEntitySchema).default([]),
  exits: z.array(sceneExitSchema).default([]),
  tileData: z.array(z.array(z.number())).optional(),
  ambientAudio: z.string().optional(),
});
