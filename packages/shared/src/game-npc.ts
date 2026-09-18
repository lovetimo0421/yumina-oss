import { z } from 'zod';

const boundedInt = z.number().int().min(0).max(1_000_000);
const unsignedInt = z.number().int().min(0).max(4_294_967_295);
export const daveDirectionKindSchema = z.enum([
  'fair_terms','raise_stakes','extend_time','rally_plants','reveal_clue','switch_lane',
  'call_sunflower','call_peashooter','call_wallnut',
]);
export const daveSpeakerSchema = z.enum(['dave','sunflower','peashooter','wallnut']);
// Native observations for a contract receipt; they never grant platform funds.
export const daveScenarioEarnedSchema = z.object({
  advanceSun:boundedInt,rewardSun:boundedInt,returnedSun:boundedInt,spentSun:boundedInt,
  plantGrants:z.number().int().min(0).max(999),mowerRepairs:z.number().int().min(0).max(999),
  heals:z.number().int().min(0).max(999),
}).strict();
export const daveScenarioSchema = z.object({
  version:z.literal(1),
  // Missing markers preserve old rules and unknown historical reward totals.
  rulesVersion:z.literal(2).optional(),
  earned:daveScenarioEarnedSchema.optional(),
  requiredCells:z.array(z.object({row:z.number().int().min(0).max(5),column:z.number().int().min(0).max(8)}).strict()).max(5)
    .refine(cells=>new Set(cells.map(cell=>`${cell.row}:${cell.column}`)).size===cells.length,'Duplicate formation cell').optional(),
  holdRemainingTicks:unsignedInt.optional(),
  suppliesRemaining:z.number().int().min(0).max(6).optional(),
  supplyCooldownTicks:unsignedInt.optional(),
  hasChampion:z.boolean().optional(),
  candidateRows:z.array(z.number().int().min(0).max(5)).max(3)
    .refine(rows=>new Set(rows).size===rows.length,'Duplicate case candidate').optional(),
  choiceReady:z.boolean().optional(),
  clueCooldownTicks:unsignedInt.optional(),
  chosenCandidateRow:z.number().int().min(-1).max(5).optional(),
  cupSwaps:z.array(z.object({fromRow:z.number().int().min(0).max(5),toRow:z.number().int().min(0).max(5)}).strict()
    .refine(pair=>pair.fromRow!==pair.toRow,'A cup cannot swap with itself')).max(3).optional(),
  evidenceStep:z.number().int().min(0).max(2).optional(),
  permitName:z.number().int().min(0).max(2).optional(),
  hazardRemainingTicks:z.number().int().min(0).max(3000).optional(),
  fuel:z.number().int().min(0).max(100).optional(),
  growthProgressTicks:z.number().int().min(0).max(999).optional(),
  supplySeed:z.number().int().min(0).max(52).optional(),
  supplyPrice:z.number().int().min(0).max(9990).optional(),
  supplyAvailable:z.boolean().optional(),
  supportSeed:z.number().int().min(0).max(52).optional(),
  supportPrice:z.number().int().min(0).max(9990).optional(),
  supportAvailable:z.boolean().optional(),
  nextDeliverySeed:z.number().int().min(0).max(52).optional(),
  collectedSeedMask:z.number().int().min(0).max(7).optional(),
  collectedSeedTypes:z.number().int().min(0).max(3).optional(),
  cluesRemaining:z.number().int().min(0).max(13).optional(),
  lastProvenMineCell:z.object({row:z.number().int().min(0).max(5),column:z.number().int().min(0).max(8)}).strict().optional(),
  mineTransition:z.enum(['next_legal_row_plus_3','next_legal_row_reflect_column']).optional(),
  prizeSeed:z.number().int().min(0).max(52).optional(),
  prizeRow:z.number().int().min(-1).max(5).optional(),
  prizeColumn:z.number().int().min(-1).max(8).optional(),
  fallbackSun:z.number().int().min(0).max(9990).optional(),
  bucketheadBountyAvailable:z.boolean().optional(),
  bucketheadBountySun:z.number().int().min(0).max(9990).optional(),
  scoringRows:z.array(z.number().int().min(0).max(5)).max(6)
    .refine(rows=>new Set(rows).size===rows.length,'Duplicate scoring row').optional(),
  nextBlastRow:z.number().int().min(-1).max(5).optional(),
  nextBlastColumn:z.number().int().min(-1).max(8).optional(),
  nextStrikeRow:z.number().int().min(-1).max(5).optional(),
  nextStrikeColumn:z.number().int().min(-1).max(8).optional(),
  fogClearRemainingTicks:unsignedInt.optional(),
  id:z.enum(['race','loan','price_swap','champion','reverse','conveyor','graves','formation','traffic',
    'auction','headcount','detective','wind','mines','bank','storm','fever','finale']),
  phase:z.enum(['briefing','active','twist','won','lost']),
  revision:boundedInt,beat:z.number().int().min(0).max(3),variant:z.number().int().min(0).max(2),
  remainingTicks:unsignedInt,progress:boundedInt,goal:boundedInt,
  balance:z.number().int().min(-1_000_000).max(1_000_000),
  targetRow:z.number().int().min(-1).max(5),targetColumn:z.number().int().min(-1).max(8),
  // Public clue and action masks only; never include a native hidden answer.
  clues:unsignedInt,actionFlags:unsignedInt,
  companion:daveSpeakerSchema,
  // The companion owns the bounded native helper. A speaker only selects the
  // current conversation, and is absent in compatible older snapshots.
  speaker:daveSpeakerSchema.optional(),
  waveMultiplier:z.union([z.literal(1),z.literal(2),z.literal(3)]),
  capabilities:z.array(daveDirectionKindSchema).max(9)
    .refine(kinds=>new Set(kinds).size===kinds.length,'Duplicate capability'),
}).strict();
const davePublicScenarioSchema=daveScenarioSchema.superRefine((scenario,ctx)=>{
  const candidates=scenario.candidateRows;
  if(scenario.chosenCandidateRow!==undefined&&scenario.chosenCandidateRow>=0&&!candidates?.includes(scenario.chosenCandidateRow))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['chosenCandidateRow'],message:'Chosen case candidate is not published'});
  scenario.cupSwaps?.forEach((swap,index)=>{
    if(!candidates?.includes(swap.fromRow))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cupSwaps',index,'fromRow'],message:'Cup swap source is not a published candidate'});
    if(!candidates?.includes(swap.toRow))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cupSwaps',index,'toRow'],message:'Cup swap destination is not a published candidate'});
  });
});
export const daveDirectionSchema = z.object({
  revision:boundedInt,kind:daveDirectionKindSchema,
  row:z.number().int().min(0).max(5).optional(),column:z.number().int().min(0).max(8).optional(),
}).strict();
export type DaveScenario = z.infer<typeof daveScenarioSchema>;
export type DaveSpeaker = z.infer<typeof daveSpeakerSchema>;
export type DaveDirectionKind = z.infer<typeof daveDirectionKindSchema>;
export type DaveDirection = z.infer<typeof daveDirectionSchema>;
export const daveSnapshotSchema = z.object({
  version: z.literal(1), game: z.literal('pvz'), mode: z.literal('adventure'),
  offerCatalogVersion: z.literal(2).optional(),
  runId: z.string().uuid(), levelEpoch: boundedInt, level: z.number().int().min(1).max(50),
  wave: z.number().int().min(0).max(100), waves: z.number().int().min(0).max(100),
  threatMultiplier: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)]), sun: boundedInt,
  scenario:davePublicScenarioSchema.optional(),
  rows: z.array(z.object({row:z.number().int().min(0).max(5), plants:boundedInt, enemies:boundedInt, mower:z.boolean()}).strict()).max(6)
    .refine(rows => new Set(rows.map(r => r.row)).size === rows.length, 'Duplicate row'),
  selectedPlants: z.array(z.string().max(64)).max(10),
  planted: z.array(z.object({type:z.number().int().min(0).max(52),row:z.number().int().min(0).max(5),column:z.number().int().min(0).max(8),health:boundedInt,maxHealth:z.number().int().min(1).max(1_000_000)}).strict()).max(162).optional(),
  adventureCycle: boundedInt.optional(),
  elapsedTicks: z.number().int().nonnegative().max(4_294_967_295).optional(),
  terrain: z.enum(['day','night','pool','fog','roof']).optional(),
  conveyor: z.boolean().optional(),
  visibleEnemies: z.array(z.object({type:z.number().int().min(0).max(32),count:boundedInt}).strict()).max(33).optional(),
  fogMasked: z.boolean().optional(),
  challengeState: z.enum(['none','active','completed','failed']).optional(),
  interactionFlags: z.number().int().min(0).max(7).optional(),
  phase: z.enum(['playing','lost']).optional(),
  defeated: z.boolean().optional(),
  encounter: z.enum(['none','offered','carried','empty','sun','declined','expired','demo_empty','demo_sun']).optional(),
  encounterPrice: z.union([z.literal(25),z.literal(50)]).optional(),
  encounterPitch: z.enum(['labels','tested','emergency','weather']).optional(),
  encounterReward: z.union([z.literal(0),z.literal(75),z.literal(150)]).optional(),
  cherryUnlocked: z.boolean(), offersUsed: z.number().int().min(0).max(127),
  recentEvents: z.array(z.enum(['wave_clear','mower_used','plant_lost','offer_completed'])).max(8),
}).strict().refine(s => s.defeated === undefined || s.defeated === (s.phase === 'lost'), 'Inconsistent outcome')
  .superRefine((s,ctx) => {
    const price=s.encounterPrice??25,pitch=s.encounterPitch??'labels';
    const empty=s.encounter==='empty'||s.encounter==='demo_empty';
    const sun=s.encounter==='sun'||s.encounter==='demo_sun';
    const demo=s.encounter==='demo_empty'||s.encounter==='demo_sun';
    if((price===25)!==(pitch==='labels'))ctx.addIssue({code:z.ZodIssueCode.custom,path:['encounterPitch'],message:'Inconsistent tin terms'});
    if(demo&&price!==50)ctx.addIssue({code:z.ZodIssueCode.custom,path:['encounter'],message:'Legacy tins cannot be demonstrated'});
    // Missing metadata means a legacy save. Modern revealed results must be
    // explicit; a sealed or expired tin must never carry its hidden contents.
    if((s.encounterReward!==undefined&&!empty&&!sun)||
       (price===50&&(empty||sun)&&s.encounterReward===undefined)||
       (empty&&s.encounterReward!==undefined&&s.encounterReward!==0)||
       (sun&&s.encounterReward===0)||(price===25&&s.encounterReward===150))
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['encounterReward'],message:'Inconsistent or unrevealed tin contents'});
  });
export const daveRequestSchema = z.object({
  accountId:z.string().min(1).max(128),
  campaignId:z.union([z.literal('legacy'),z.string().uuid()]).optional(),
  adventureName:z.string().trim().min(1).max(96).optional(),
  provider:z.enum(['official','private']).optional(),
  requestId:z.string().uuid(), model:z.string().trim().min(1).max(256), locale:z.enum(['en','zh','es']),
  trigger:z.enum(['player','wave_clear','lawn_danger','arrival','idle','interaction','encounter']), snapshot:daveSnapshotSchema,
  notebookRevision:boundedInt.optional(),
  messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(1000)}).strict()).min(1).max(12),
}).strict();
export const daveOfferSchema = z.object({
  id:z.string().uuid(), kind:z.enum(['sun_gift','cherry_bomb_trade','no_shovel_challenge','mystery_tin','sunflower_gift','sun_shower','wall_nut_gift','lawn_mower_gift']),
  sunCost:z.number().int().min(0).max(150), sunReward:z.number().int().min(0).max(75), expiresAtWave:z.number().int().min(0).max(100),
}).strict();
export const daveRelationshipSchema = z.object({
  affection:z.number().int().min(0).max(100), irritation:z.number().int().min(0).max(100),
  mood:z.enum(['curious','cheerful','worried','sulking','scheming','touched']),
  awayUntil:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  partingLine:z.string().max(900),
}).strict();
export const daveReplySchema = z.object({requestId:z.string().uuid(),runId:z.string().uuid(),levelEpoch:boundedInt,text:z.string().max(900),offer:daveOfferSchema.nullable(),notebookRevision:boundedInt.optional(),memoryQuote:z.string().min(1).max(180).optional(),
  direction:daveDirectionSchema.optional(),
  behavior:z.enum(['stay','leave','silent']).optional(),relationship:daveRelationshipSchema.optional(),
}).strict().refine(r=>r.text.length>0||r.behavior==='silent','Only a silent decision can omit dialogue');
export type DaveRequest = z.infer<typeof daveRequestSchema>;
export type DaveReply = z.infer<typeof daveReplySchema>;
