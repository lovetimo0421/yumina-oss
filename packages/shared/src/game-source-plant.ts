import { z } from 'zod';

// A live Adventure identity. This is not a durable Garden identity.
export const sourcePlantTargetSchema=z.object({
 runId:z.string().uuid(),levelEpoch:z.number().int().min(0).max(1_000_000),
 id:z.number().int().min(1).max(4_294_967_295),
}).strict();
export type SourcePlantTarget=z.infer<typeof sourcePlantTargetSchema>;

const leaseNumber=z.number().int().min(1).max(1_000_000_000);
export const sourcePlantBondLeaseSchema=z.object({
 token:leaseNumber,revision:leaseNumber,wave:z.number().int().min(1).max(100),
 expiresAtTick:leaseNumber,score:z.number().int().min(-3).max(3),
}).strict();
export type SourcePlantBondLease=z.infer<typeof sourcePlantBondLeaseSchema>;
export const sourcePlantRequestKindSchema=z.enum(['hold_lane','company']);
export type SourcePlantRequestKind=z.infer<typeof sourcePlantRequestKindSchema>;
const promiseStatusSchema=z.enum(['offered','active','kept','broken','missed','lost','declined']);
const promiseCounter=z.number().int().min(0).max(4_294_967_295);
export const sourcePlantPromiseSchema=z.object({
 token:promiseCounter.min(1),kind:sourcePlantRequestKindSchema,status:promiseStatusSchema,
 deadlineWave:z.number().int().min(0).max(100),
}).strict();
export const sourcePlantPromiseMemorySchema=z.object({
 kept:promiseCounter,broken:promiseCounter,
 lastKind:z.enum(['none','hold_lane','company']),
 lastOutcome:z.enum(['none','offered','active','kept','broken','missed','lost','declined']),
}).strict();
export const sourcePlantBondSchema=z.object({
 score:z.number().int().min(-3).max(3),polarity:z.number().int().min(-1).max(1),
 lastNonzeroWave:z.number().int().min(0).max(100),lease:sourcePlantBondLeaseSchema.optional(),
 requestOptions:z.array(sourcePlantRequestKindSchema).max(2)
  .refine(options=>new Set(options).size===options.length,'Duplicate plant request').optional(),
 promise:sourcePlantPromiseSchema.optional(),promiseMemory:sourcePlantPromiseMemorySchema.optional(),
}).strict();
export const sourcePlantRequestSchema=z.object({
 token:leaseNumber,revision:leaseNumber,kind:sourcePlantRequestKindSchema,
}).strict();
export type SourcePlantRequest=z.infer<typeof sourcePlantRequestSchema>;
export const sourcePlantReactionKindSchema=z.enum(['warmer','colder','unchanged']);
export const sourcePlantReactionSchema=z.object({
 token:leaseNumber,revision:leaseNumber,reaction:sourcePlantReactionKindSchema,
}).strict();
export type SourcePlantReaction=z.infer<typeof sourcePlantReactionSchema>;
export function sourcePlantBondSeedSupported(seed:number,sourceLevel?:number):boolean {
 return (seed>=0&&seed<=9)||seed===40||(seed===10&&[40161,40162,40163,40164,40165].includes(sourceLevel??0))||(seed===13&&(sourceLevel===40164||sourceLevel===40165));
}
export function source27LivingPlantMatches(p:{type:number;sourceId?:number;textOnly?:true;bond?:unknown}):boolean {
 const special=p.type===11?[120,125]:p.type===12?[130]:p.type===14?[150,155]:[];
 if(special.length)return special.includes(p.sourceId??0)&&p.textOnly===true&&p.bond===undefined;
 return ((p.type>=0&&p.type<=10)||p.type===13||p.type===40)&&p.sourceId===(p.type+1)*10&&p.textOnly===undefined;
}
// These chapters expose exact living species for conversation. Card generations
// are not plant identity, and no bond or action capability is introduced here.
export function sourceLivingPlantMatches(level:number,sourceLevel:number|undefined,p:{type:number;sourceId?:number;textOnly?:true;bond?:unknown}):boolean {
 if(p.textOnly!==true||p.bond!==undefined||!Number.isInteger(p.type)||p.sourceId===undefined)return false;
 if(level===13&&sourceLevel===40161)return p.type===11&&[120,125].includes(p.sourceId);
 const normal=p.sourceId===(p.type+1)*10;
 if(level===18&&sourceLevel===40166)return normal&&((p.type>=0&&p.type<=15)||p.type===40)||p.type===11&&p.sourceId===125;
 if(level===19&&sourceLevel===40167)return normal&&((p.type>=0&&p.type<=15)||p.type===40||p.type===42)||
  p.type===2&&p.sourceId===35||p.type===11&&p.sourceId===125||p.type===13&&p.sourceId===145||p.type===14&&p.sourceId===155;
 if(level===20&&sourceLevel===40159)return normal&&((p.type>=8&&p.type<=15)||p.type===42);
 if(level===21&&sourceLevel===40168)return normal&&((p.type>=0&&p.type<=16)||p.type===40||p.type===42);
 return false;
}
export function sourcePlantBondLeaseMatches(a:SourcePlantBondLease,b:SourcePlantBondLease|undefined):boolean {
 return b!==undefined&&a.token===b.token&&a.revision===b.revision&&a.wave===b.wave&&a.expiresAtTick===b.expiresAtTick&&a.score===b.score;
}

export function sourcePlantBondChapterSupported(level:number,sourceLevel:number|undefined):boolean {
 return (level===11&&sourceLevel===40158)||(level===12&&sourceLevel===40160)||(level===13&&sourceLevel===40161)||(level===14&&sourceLevel===40162)||(level===15&&sourceLevel===40163)||(level===16&&sourceLevel===40164)||(level===17&&sourceLevel===40165);
}
