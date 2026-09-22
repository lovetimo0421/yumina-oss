import {z} from 'zod';
// A capability for one currently offered native promise, never a stat command.
export const classicPlantChoiceSchema=z.object({
 plantId:z.number().int().min(1).max(4_294_967_295),token:z.number().int().min(0).max(999_999_999),
 kind:z.enum(['none','company','hold_lane']),wave:z.number().int().min(0).max(9998),
 score:z.number().int().min(-3).max(3),kept:z.number().int().nonnegative().max(9999),broken:z.number().int().nonnegative().max(9999),
 rhythmVersion:z.literal(1).optional(),
 status:z.enum(['none','offered','active','kept','broken','missed','declined']).optional(),
 deadlineWave:z.number().int().min(0).max(10000).optional(),
 requestKind:z.enum(['company','hold_lane']).optional(),
 appetite:z.enum(['any','armor']).optional(),
 appetiteRevision:z.number().int().min(0).max(999_999_999).optional(),
 canDirect:z.boolean().optional(),armoredMeals:z.number().int().min(0).max(9999).optional(),
 garlicDirection:z.number().int().min(-1).max(1).optional(),
 garlicRevision:z.number().int().min(0).max(999_999_997).optional(),
 garlicUp:z.boolean().optional(),garlicDown:z.boolean().optional(),
 lightMode:z.union([z.literal(0),z.literal(1)]).optional(),
 lightRevision:z.number().int().min(0).max(999_999_998).optional(),
}).strict();
export const classicPlantAnswerSchema=classicPlantChoiceSchema.extend({decision:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(7),z.literal(8),z.literal(9),z.literal(10),z.null()])});
