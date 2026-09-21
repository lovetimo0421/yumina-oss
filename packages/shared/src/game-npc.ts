import { z } from 'zod';
import {classicPlantChoiceSchema,classicPlantAnswerSchema} from './game-classic-plant.js';
import {classicStoryChoiceSchema,classicStoryAnswerSchema,sunDoubleSchema,giftShuffleSchema} from './game-classic-story.js';
import { source31ChoiceText,source31CurrentChoiceSchema,sourceStorySchema, sourceStoryActionSchema,sourceStoryChoiceSchema,sourceChoiceSchema,sourceStoryNumericSchema } from './game-source-story.js';
import { sourcePlantTargetSchema,sourcePlantBondSchema,sourcePlantBondLeaseSchema,sourcePlantReactionSchema,sourcePlantRequestSchema,sourcePlantBondSeedSupported,sourcePlantBondLeaseMatches,sourcePlantBondChapterSupported,source27LivingPlantMatches } from './game-source-plant.js';

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
  version: z.literal(1), game: z.literal('pvz'), mode: z.enum(['adventure','garden']),
  garden:z.object({id:z.string().regex(/^[0-9a-f]{16}$/),seed:z.number().int().min(0).max(48),age:z.number().int().min(0).max(3),need:z.number().int().min(0).max(4),happy:z.boolean(),place:z.number().int().min(0).max(3)}).strict().optional(),
  offerCatalogVersion: z.literal(2).optional(),
  runId: z.string().uuid(), levelEpoch: boundedInt, level: z.number().int().min(1).max(50),
  wave: z.number().int().min(0).max(100), waves: z.number().int().min(0).max(100),
  threatMultiplier: z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)]), sun: z.number().int().min(-1_000_000).max(1_000_000),
  scenario:davePublicScenarioSchema.optional(),
  sourceStory:sourceStorySchema.optional(),
  rows: z.array(z.object({row:z.number().int().min(0).max(5), plants:boundedInt, enemies:boundedInt, mower:z.boolean()}).strict()).max(6)
    .refine(rows => new Set(rows.map(r => r.row)).size === rows.length, 'Duplicate row'),
  selectedPlants: z.array(z.string().max(64)).max(10),
  plantIdentityVersion:z.literal(1).optional(),
  planted: z.array(z.object({textOnly:z.literal(true).optional(),sourceId:z.number().int().refine(id=>[10,20,30,40,50,60,70,80,90,100,110,120,125,130,140,145,150,155,410].includes(id)).optional(),id:z.number().int().min(1).max(4_294_967_295).optional(),type:z.number().int().min(0).max(52),row:z.number().int().min(0).max(5),column:z.number().int().min(0).max(8),health:boundedInt,maxHealth:z.number().int().min(1).max(1_000_000),bond:sourcePlantBondSchema.optional()}).strict()).max(162).optional(),
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
  headPrize:z.object({stage:z.enum(['none','offered','enrolled','paid','reclaimed','declined','expired']),heads:z.number().int().min(0).max(1024),target:z.literal(20),reward:z.literal(500),repayment:z.literal(600)}).strict().optional(),
  headMagic:z.object({stage:z.enum(['waiting','windup','transformed','missed'])}).strict().optional(),
  sunDouble:sunDoubleSchema.optional(),
  giftShuffle:giftShuffleSchema.optional(),
  cherryUnlocked: z.boolean(), offersUsed: z.number().int().min(0).max(127),
  recentEvents: z.array(z.enum(['wave_clear','mower_used','plant_lost','offer_completed'])).max(8),
}).strict().refine(s => s.defeated === undefined || s.defeated === (s.phase === 'lost'), 'Inconsistent outcome')
  .superRefine((s,ctx) => {
    if(s.mode==='garden'?(!s.garden||s.sourceStory||s.scenario||s.wave!==0||s.waves!==0||s.sun!==0||s.offersUsed!==0||s.rows.length||s.selectedPlants.length||s.planted?.length||s.visibleEnemies?.length||s.headPrize||s.headMagic||s.sunDouble||s.giftShuffle||s.defeated||s.phase!=='playing'||s.threatMultiplier!==1||s.cherryUnlocked||s.recentEvents.length||(s.interactionFlags??0)!==0||s.encounter&&s.encounter!=='none'||s.encounterPrice!==undefined||s.encounterPitch!==undefined||s.encounterReward!==undefined):!!s.garden)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['garden'],message:'Garden observations cannot carry Adventure effects'});
    if(s.headPrize&&(s.level!==23||s.sourceStory||s.scenario||s.conveyor))ctx.addIssue({code:z.ZodIssueCode.custom,path:['headPrize'],message:'Head prize belongs to ordinary classic 3-3'});
    if(s.headMagic&&(s.level!==23||s.sourceStory||s.scenario||s.conveyor))ctx.addIssue({code:z.ZodIssueCode.custom,path:['headMagic'],message:'Head magic belongs to ordinary classic 3-3'});
    if(s.sunDouble&&(s.level!==24||s.sourceStory||s.scenario||s.conveyor))ctx.addIssue({code:z.ZodIssueCode.custom,path:['sunDouble'],message:'Sun exchange belongs to ordinary classic 3-4'});
    if(s.giftShuffle&&(s.level!==31||s.sourceStory||s.scenario||s.conveyor))ctx.addIssue({code:z.ZodIssueCode.custom,path:['giftShuffle'],message:'Gift shuffle belongs to ordinary classic 4-1'});
    if(s.plantIdentityVersion===1) {
      if((!s.sourceStory&&!(s.level>=22&&s.level<=50&&!s.scenario))||!s.planted||s.planted.some(p=>p.id===undefined)||
         new Set(s.planted.map(p=>p.id)).size!==s.planted.length)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['planted'],message:'Source plant identities must be complete and unique'});
    } else if(s.planted?.some(p=>p.id!==undefined))
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['plantIdentityVersion'],message:'Plant identity requires its protocol marker'});
    s.planted?.forEach((plant,index)=>{
      if(plant.sourceId!==undefined&&!(s.plantIdentityVersion===1&&((s.level===17&&s.sourceStory?.sourceLevel===40165&&source27LivingPlantMatches(plant))||(s.level===14&&s.sourceStory?.sourceLevel===40162&&plant.type===11&&[120,125].includes(plant.sourceId))||([15,16].includes(s.level)&&s.sourceStory?.sourceLevel===(s.level===16?40164:40163)&&plant.sourceId===(plant.type+1)*10&&[120,130].includes(plant.sourceId)&&plant.textOnly===true)||(s.level===16&&s.sourceStory?.sourceLevel===40164&&((plant.type===13&&[140,145].includes(plant.sourceId))||((plant.type<=10||plant.type===40)&&plant.sourceId===(plant.type+1)*10))))))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['planted',index,'sourceId'],message:'Special source identity requires a source2-4 native11 living plant'});
      if(plant.textOnly!==undefined&&!(s.level===17&&s.sourceStory?.sourceLevel===40165&&source27LivingPlantMatches(plant))&&(!((s.level===15&&s.sourceStory?.sourceLevel===40163)||(s.level===16&&s.sourceStory?.sourceLevel===40164))||!plant.sourceId||![120,130].includes(plant.sourceId)||plant.bond))ctx.addIssue({code:z.ZodIssueCode.custom,path:['planted',index],message:'Text-only special plant cannot carry a bond'});
      if(plant.bond&&(!sourcePlantBondChapterSupported(s.level,s.sourceStory?.sourceLevel)||s.plantIdentityVersion!==1||!sourcePlantBondSeedSupported(plant.type,s.sourceStory?.sourceLevel)))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['planted',index,'bond'],message:'Plant bonds require a supported native night-chapter plant identity'});
    });
    if(s.sun<0&&!s.sourceStory&&!(s.level===23&&s.headPrize?.stage==='reclaimed'&&s.sun>=-600))ctx.addIssue({code:z.ZodIssueCode.custom,path:['sun'],message:'Negative classic sun requires the witnessed head-prize reclamation'});
    if(s.sourceStory) {
      if(s.sourceStory.sourceLevel===40168&&(s.level!==21||s.plantIdentityVersion!==undefined||s.planted!==undefined))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source31 requires native21 without plant projection'});
      if(s.sourceStory.sourceLevel===40166&&(s.level!==18||s.plantIdentityVersion!==undefined||s.planted?.length))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source28 requires native18; living plant projection is not integrated'});
      if(s.sourceStory.sourceLevel===40159&&(s.level!==20||s.plantIdentityVersion!==undefined||s.planted?.length))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source210 requires native20; living plant projection is not integrated'});
      if(s.sourceStory.sourceLevel===40167&&(s.level!==19||s.plantIdentityVersion!==undefined||s.planted?.length))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source29 requires native19; living plant projection is not integrated'});
      if(s.sourceStory.sourceLevel===40165&&(s.level!==17||s.planted?.some(p=>!source27LivingPlantMatches(p))))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source27 requires native17'});
      if(s.sourceStory.sourceLevel===40164&&(s.level!==16||s.planted?.some(p=>!p.sourceId||(p.type===13?![140,145].includes(p.sourceId):p.sourceId!==(p.type+1)*10))))ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source26 requires native16 and exact living source identities'});
      if(s.sourceStory.sourceLevel===40163&&s.level!==15)ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source2-5 requires native15'});
      if(s.sourceStory.sourceLevel===40162&&s.level!==14)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source2-4 requires native level14'});
      if(s.sourceStory.sourceLevel===40161&&s.level!==13)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source2-3 requires native level13'});
      if(s.sourceStory.sourceLevel===40160&&s.level!==12)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source2-2 requires native level12'});
      if(s.sourceStory.sourceLevel===40158&&s.level!==11)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source2-1 requires native level11'});
      if(s.sourceStory.sourceLevel===40149&&s.level!==10)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source1-10 requires native level10'});
      if(s.sourceStory.sourceLevel===40157&&s.level!==9)
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['level'],message:'Source1-9 requires native level9'});
      if(s.scenario||s.offersUsed!==0||(s.interactionFlags??0)!==0||
         (s.encounter!==undefined&&s.encounter!=='none'))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStory'],message:'Source story cannot advertise legacy effects'});
      if(s.elapsedTicks===undefined||(s.sourceStory.opportunity&&
         (s.sourceStory.opportunity.expiresAtTick<=s.elapsedTicks||s.phase==='lost'||s.defeated)))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStory','opportunity'],message:'Missing or expired source clock'});
      if(s.sourceStory.events.some(e=>e.level>s.level))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStory','events'],message:'Future source history is not public'});
    }
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
  activeProfileId:z.string().min(1).max(128).optional(),
  requestId:z.string().uuid(), model:z.string().trim().min(1).max(256), locale:z.enum(['en','zh','es']),
  trigger:z.enum(['player','wave_clear','lawn_danger','arrival','idle','interaction','encounter','source_auto']), snapshot:daveSnapshotSchema,
  notebookRevision:boundedInt.optional(),
  sourcePlantTarget:sourcePlantTargetSchema.optional(),
  classicPlantChoice:classicPlantChoiceSchema.optional(),
  classicStoryChoice:classicStoryChoiceSchema.optional(),
  sourcePlantBondLease:sourcePlantBondLeaseSchema.optional(),
  sourceStoryChoice:sourceStoryChoiceSchema.optional(),
  sourceStoryNumeric:sourceStoryNumericSchema.optional(),
  messages:z.array(z.object({role:z.enum(['user','assistant']),content:z.string().min(1).max(1000)}).strict()).min(1).max(12),
}).strict().superRefine((request,ctx)=>{
  if(request.snapshot.mode==='garden'&&(request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||request.classicStoryChoice||request.classicPlantChoice||request.sourcePlantTarget||request.sourcePlantBondLease||request.sourceStoryChoice||request.sourceStoryNumeric))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['snapshot'],message:'Garden conversation requires an explicit player message without combat capabilities'});
  if(request.classicStoryChoice){
    const s=request.snapshot,c=request.classicStoryChoice;
    const validOffer=c.kind==='gift_shuffle'?s.level===31&&s.giftShuffle?.revision===c.revision&&s.giftShuffle.stage===c.stage&&s.giftShuffle.opened===c.opened&&(c.stage!==1||c.wave<5):c.kind==='head_prize'?s.level===23&&s.headPrize?.stage==='offered':
      s.level===24&&s.sunDouble?.stage==='offered'&&s.sunDouble.round===c.round&&c.wave>=[6,8,11][c.round-1]!&&c.wave<[6,8,11][c.round-1]!+2;
    if(request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||s.sourceStory||s.scenario||s.conveyor||
      s.phase!=='playing'||s.defeated||!validOffer||s.wave!==c.wave||
      request.classicPlantChoice||request.sourcePlantTarget||request.sourcePlantBondLease||request.sourceStoryChoice||request.sourceStoryNumeric)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['classicStoryChoice'],message:'Answer requires the current native story offer'});
  }
  if(request.classicPlantChoice){
    const s=request.snapshot,c=request.classicPlantChoice,p=s.planted?.find(p=>p.id===c.plantId);
    const neutral=c.status==='none';
    if(request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||s.sourceStory||s.scenario||s.conveyor||
      s.level<22||s.level>49||s.phase!=='playing'||s.defeated||s.plantIdentityVersion!==1||s.wave!==c.wave||
      (neutral?(c.token!==0||c.kind!=='none'||c.deadlineWave!==0):(c.token===0||c.kind==='none'||c.wave<2))||
      ((c.status??'offered')==='offered'&&c.wave+2>s.waves)||
      (c.status==='active'&&(!c.deadlineWave||c.deadlineWave<=c.wave||c.deadlineWave>c.wave+2))||
      (c.status===undefined&&c.deadlineWave!==undefined)||
      ([c.appetite,c.appetiteRevision,c.canDirect,c.armoredMeals].some(v=>v!==undefined)&&
       (p?.type!==6||c.appetite===undefined||c.appetiteRevision===undefined||c.canDirect===undefined||c.armoredMeals===undefined||!c.status||c.requestKind!==undefined))||
      ([c.garlicDirection,c.garlicRevision,c.garlicUp,c.garlicDown].some(v=>v!==undefined)&&
       (p?.type!==36||!neutral||c.garlicDirection===undefined||c.garlicRevision===undefined||c.garlicUp===undefined||c.garlicDown===undefined||c.requestKind!==undefined))||
      (c.requestKind!==undefined&&(!c.status||['offered','active'].includes(c.status)||c.wave<2||c.wave+2>s.waves||c.score>=3||
        (c.requestKind==='company'&&![1,9,41].includes(p?.type??-1))))||
      !p||p.health<=0||p.type>48||request.sourcePlantTarget||request.sourcePlantBondLease||request.sourceStoryChoice||request.sourceStoryNumeric)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['classicPlantChoice'],message:'Promise answer requires the current living classic plant and offered wave'});
  }
  if(request.sourceStoryChoice){
    const s=request.snapshot,story=s.sourceStory;
    if(request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||request.sourcePlantTarget||request.sourcePlantBondLease||
      s.phase!=='playing'||s.defeated||!story||story.phase!=='choice'||story.hammerPending||
      story.sceneId!==request.sourceStoryChoice.sceneId||(story.sceneKind!==undefined&&story.sceneKind!=='select'))
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStoryChoice'],message:'Choice answer requires the current authored Dave choice and an explicit player message'});
  }
  const answer=request.sourceStoryChoice??request.sourceStoryNumeric,story=request.snapshot.sourceStory;
  const answer31=request.sourceStoryChoice;
  if(story?.sourceLevel===40168){
   const current=source31CurrentChoiceSchema.safeParse(story.choice),labels=source31ChoiceText(story.sceneId,request.locale);
   if(!answer31||request.sourceStoryNumeric||!current.success||!labels||answer31.epoch!==request.snapshot.levelEpoch||
    (current.success&&(answer31.epoch!==current.data.epoch||answer31.owner!==current.data.owner||answer31.choiceRevision!==current.data.choiceRevision))||
    answer31.prompt!==labels?.prompt||JSON.stringify(answer31.options)!==JSON.stringify(labels?.options))
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStoryChoice'],message:'Source31 requires the exact native capability and authored localized options'});
  }else if(answer31&&(answer31.epoch!==undefined||answer31.owner!==undefined||answer31.choiceRevision!==undefined))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStoryChoice'],message:'Source31 identity cannot authorize another chapter'});
  if(request.sourceStoryNumeric){const s=request.snapshot;
   if(request.sourceStoryChoice||request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||request.sourcePlantTarget||request.sourcePlantBondLease||!((s.level===15&&story?.sourceLevel===40163)||(s.level===16&&story?.sourceLevel===40164)||(s.level===17&&story?.sourceLevel===40165)||(s.level===18&&story?.sourceLevel===40166)||(s.level===19&&story?.sourceLevel===40167)||(s.level===20&&story?.sourceLevel===40159))||s.phase!=='playing'||s.defeated||story.phase!=='choice'||story.hammerPending||story.sceneId!==request.sourceStoryNumeric.sceneId||JSON.stringify(story.choice?.numeric)!==JSON.stringify(request.sourceStoryNumeric.numeric))ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStoryNumeric'],message:'Numeric answer requires this exact current offer and player turn'});
  }
  if(answer&&([40159,40163,40164,40165,40166,40167].includes(story?.sourceLevel??0)||'eventToken' in answer||'storyRevision' in answer||'eventKey' in answer)){
   const c=story?.choice;
   if(!c||answer.sceneRevision!==c.sceneRevision||answer.storyRevision!==c.storyRevision||answer.eventToken!==c.eventToken||answer.eventKey!==c.eventKey||answer.sceneId!==c.eventKey||c.kind!==(request.sourceStoryNumeric?'numeric':'binary'))ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourceStoryChoice'],message:'Authored answer capability changed'});
  }
  if(request.sourcePlantTarget&&[40168,40159,40166,40167].includes(story?.sourceLevel??0))ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourcePlantTarget'],message:'Plant routes for this chapter are not integrated'});
  if(request.sourcePlantTarget) {
    const target=request.sourcePlantTarget,s=request.snapshot;
    const plant=s.planted?.find(p=>p.id===target.id);
    if(request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||!s.sourceStory||s.plantIdentityVersion!==1||s.phase!=='playing'||s.defeated||
      s.sourceStory.phase==='won'||s.sourceStory.phase==='lost'||target.runId!==s.runId||target.levelEpoch!==s.levelEpoch||
      !plant||plant.health<=0||plant.type>48||
      ([40160,40161,40162,40163,40164,40165].includes(s.sourceStory?.sourceLevel??0)&&!sourcePlantBondSeedSupported(plant.type,s.sourceStory?.sourceLevel)&&(s.sourceStory.sourceLevel===40165?!source27LivingPlantMatches(plant):[40163,40164].includes(s.sourceStory.sourceLevel)?!plant.textOnly||![120,130].includes(plant.sourceId??0):(plant.type!==11||(s.sourceStory.sourceLevel===40162&&plant.sourceId!==120&&plant.sourceId!==125)))))
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourcePlantTarget'],message:'Plant is not available on this lawn'});
  }
  if(request.sourcePlantBondLease){
    const lease=request.sourcePlantBondLease,target=request.sourcePlantTarget,s=request.snapshot;
    const plant=target?s.planted?.find(p=>p.id===target.id):undefined;
    if(!target||request.trigger!=='player'||request.messages.at(-1)?.role!=='user'||!sourcePlantBondChapterSupported(s.level,s.sourceStory?.sourceLevel)||
      !s.sourceStory||s.plantIdentityVersion!==1||s.phase!=='playing'||s.defeated||s.sourceStory.phase==='won'||s.sourceStory.phase==='lost'||
      target.runId!==s.runId||target.levelEpoch!==s.levelEpoch||!plant||plant.health<=0||!sourcePlantBondSeedSupported(plant.type,s.sourceStory?.sourceLevel)||
      !sourcePlantBondLeaseMatches(lease,plant.bond?.lease)||plant.bond?.score!==lease.score||lease.wave!==s.wave||
      s.elapsedTicks===undefined||lease.expiresAtTick<=s.elapsedTicks)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['sourcePlantBondLease'],message:'Plant reaction requires the exact current native lease'});
  }
  if(request.trigger!=='source_auto')return;
  const opportunity=story?.opportunity;
  if(!request.campaignId||request.campaignId==='legacy'||request.notebookRevision===undefined||!story||!opportunity||story.phase!=='idle'||story.sceneId!==0||
     story.hammerPending||request.snapshot.phase!=='playing'||request.snapshot.defeated)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['trigger'],message:'Source automatic turn is not currently available'});
});
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
  classicPlantChoice:classicPlantAnswerSchema.optional(),
  classicStoryChoice:classicStoryAnswerSchema.optional(),
  sourcePlantTarget:sourcePlantTargetSchema.optional(),
  sourcePlantReaction:sourcePlantReactionSchema.optional(),
  sourcePlantRequest:sourcePlantRequestSchema.optional(),
  sourceChoice:sourceChoiceSchema.optional(),
  direction:daveDirectionSchema.optional(),
  sourceAction:sourceStoryActionSchema.optional(),
  behavior:z.enum(['stay','leave','silent']).optional(),relationship:daveRelationshipSchema.optional(),
}).strict().refine(r=>r.text.length>0||r.behavior==='silent','Only a silent decision can omit dialogue')
  .refine(r=>!r.classicStoryChoice||(r.text.length>0&&r.behavior==='stay'&&r.offer===null&&!r.classicPlantChoice&&!r.direction&&!r.sourceAction&&!r.sourceChoice&&!r.sourcePlantTarget&&!r.sourcePlantReaction&&!r.sourcePlantRequest),'Classic story choice cannot carry another native effect')
  .refine(r=>!r.classicPlantChoice||(r.text.length>0&&r.behavior==='stay'&&r.offer===null&&!r.classicStoryChoice&&!r.relationship&&!r.direction&&!r.sourceAction&&!r.memoryQuote&&!r.sourceChoice&&!r.sourcePlantTarget&&!r.sourcePlantReaction&&!r.sourcePlantRequest),'Classic plant choice cannot carry another effect')
  .refine(r=>!r.sourcePlantTarget||(r.sourcePlantTarget.runId===r.runId&&r.sourcePlantTarget.levelEpoch===r.levelEpoch&&
    r.text.length>0&&r.behavior==='stay'&&r.offer===null&&!r.relationship&&!r.direction&&!r.sourceAction&&!r.memoryQuote),
    'Plant conversation cannot carry Dave effects')
  .refine(r=>!r.sourcePlantReaction||r.sourcePlantTarget!==undefined,'Plant reaction requires its exact plant target')
  .refine(r=>!r.sourcePlantRequest||(r.sourcePlantTarget!==undefined&&!r.sourcePlantReaction),
    'Plant request requires its exact target and cannot also propose a reaction')
  .refine(r=>!r.sourceChoice||(r.behavior==='stay'&&r.text.length>0&&r.offer===null&&!r.sourceAction&&!r.direction&&
    !r.sourcePlantTarget&&!r.sourcePlantRequest&&!r.sourcePlantReaction),'Authored choice cannot carry another native action');
export type DaveRequest = z.infer<typeof daveRequestSchema>;
export type DaveReply = z.infer<typeof daveReplySchema>;
