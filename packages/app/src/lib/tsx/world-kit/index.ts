/**
 * The world kit chunk: what `loadWorld()` hands card code. Fetched the first
 * time a card asks for it, together with three.js.
 */
import * as THREE from "three";
import { createWorld } from "./world";

export const worldKit = { THREE, createWorld };
export type WorldKit = typeof worldKit;
export type { World, WorldOptions, RoomOptions, Opening, LookOptions } from "./world";
