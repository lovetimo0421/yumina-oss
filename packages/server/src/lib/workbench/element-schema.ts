import { z } from "zod";
import { WORKBENCH_VOICE_LANGS, WORKBENCH_ELEMENT_ASSETS_MAX, WORKBENCH_ELEMENT_DESCRIPTION_MAX, WORKBENCH_ELEMENT_KINDS, WORKBENCH_ELEMENT_NAME_RE } from "@yumina/shared";

// What an element may be made of: the workbench route and the outside-AI tool check the same.
const voiceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("elevenlabs"), voiceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict(),
  z.object({ provider: z.literal("fish"), voiceId: z.string().regex(/^[0-9a-f]{32}$/), lang: z.enum(WORKBENCH_VOICE_LANGS).optional() }).strict(),
]);
const elementFields = {
  kind: z.enum(WORKBENCH_ELEMENT_KINDS),
  name: z.string().trim().regex(WORKBENCH_ELEMENT_NAME_RE, "letters, digits, _ - · only, no spaces, 1-40"),
  description: z.string().max(WORKBENCH_ELEMENT_DESCRIPTION_MAX),
  coverAssetId: z.string().uuid().nullable(),
  assetIds: z.array(z.string().uuid()).max(WORKBENCH_ELEMENT_ASSETS_MAX),
  voice: voiceSchema.nullable(),
  rigId: z.string().uuid().nullable(),
  visibility: z.enum(["private", "public"]),
};
export const createElementSchema = z.object({ ...elementFields, description: elementFields.description.default("") })
  .partial({ coverAssetId: true, assetIds: true, voice: true, rigId: true, visibility: true }).strict();
export const patchElementSchema = z.object(elementFields).partial().strict();

