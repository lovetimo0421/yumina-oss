import {z} from 'zod';
// Identifies one authored native offer. No model-defined terms or resource values.
const headChoice=z.object({kind:z.literal('head_prize'),wave:z.number().int().min(3).max(5)}).strict();
const doubleChoice=z.object({kind:z.literal('sun_double'),round:z.number().int().min(1).max(3),wave:z.number().int().min(6).max(12)}).strict();
const shuffleChoice=z.object({kind:z.literal('gift_shuffle'),wave:z.number().int().min(2).max(100),revision:z.number().int().min(1).max(10),stage:z.union([z.literal(1),z.literal(3),z.literal(4)]),opened:z.number().int().min(-1).max(2),replayAvailable:z.boolean().optional()}).strict();
const roofChoice=z.object({kind:z.literal('roof_favor'),wave:z.number().int().min(2).max(4),revision:z.literal(2),variant:z.union([z.literal(1),z.literal(2)]),row:z.number().int().min(0).max(4)}).strict();
const tinChoice=z.object({kind:z.literal('mystery_tin'),wave:z.number().int().min(0).max(100),stage:z.enum(['offered','carried']),price:z.union([z.literal(25),z.literal(50)])}).strict();
export const classicStoryChoiceSchema=z.discriminatedUnion('kind',[headChoice,doubleChoice,shuffleChoice,roofChoice,tinChoice]);
const decision=z.union([z.literal(0),z.literal(1),z.null()]);
export const classicStoryAnswerSchema=z.discriminatedUnion('kind',[headChoice.extend({decision}),doubleChoice.extend({decision}),roofChoice.extend({decision}),tinChoice.extend({decision:z.union([z.literal(0),z.literal(1),z.literal(3),z.literal(4),z.null()])}),shuffleChoice.extend({decision:z.union([z.literal(0),z.literal(1),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.literal(7),z.null()])})]);
// 0 declines a sale or keeps an owned tin sealed. Currency and revealed contents
// still belong to the native engine; no model-defined price or reward is accepted.
export function classicTinDecisions(choice:z.infer<typeof tinChoice>,sun:number):number[]{
 return choice.stage==='carried'?[0,3]:[0,...(sun>=(choice.price===50?150:100)?[1]:[]),...(choice.price===50?[4]:[])];
}
export const roofFavorSchema=z.object({stage:z.number().int().min(0).max(5),revision:z.number().int().min(0).max(3),variant:z.number().int().min(0).max(2),row:z.number().int().min(-1).max(4),allyAlive:z.boolean()}).strict().superRefine((s,c)=>{
 const valid=s.stage===0?s.revision===0&&s.variant===0&&s.row===-1&&!s.allyAlive:
  s.variant>0&&(s.stage===1?s.revision===1&&s.row===-1&&!s.allyAlive:
  s.stage===2?s.revision===2&&s.row>=0&&!s.allyAlive:
  s.stage===3?s.revision===3&&s.row>=0:
  s.stage===4?s.revision===3&&s.row>=0&&!s.allyAlive:
  !s.allyAlive&&((s.revision===2&&s.row===-1)||(s.revision===3&&s.row>=0)));
 if(!valid)c.addIssue({code:z.ZodIssueCode.custom,message:'Invalid roof favor receipt'});
});
export const giftShuffleSchema=z.object({stage:z.number().int().min(0).max(8),revision:z.number().int().min(0).max(10),opened:z.number().int().min(-1).max(2),picked:z.number().int().min(-1).max(2),swaps:z.number().int().min(0).max(242).optional(),prize:z.number().int().min(0).max(2).optional(),replayAvailable:z.boolean().optional()}).strict().superRefine((s,ctx)=>{
 if(s.replayAvailable!==undefined&&s.replayAvailable!==(s.stage===3&&s.revision===3))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Replay requires the first unopened shuffle'});
 if((s.stage===4&&s.opened<0)||(s.stage<4&&s.opened!==-1)||
   ([5,6].includes(s.stage)?s.picked<0||s.picked===s.opened||s.prize===undefined||(s.stage===5)!==(s.picked===s.prize):s.picked!==-1||s.prize!==undefined))
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid gift reveal'});
});
const result=z.enum(['none','offered','paid','taken','declined','expired']);
export const sunDoubleSchema=z.object({round:z.number().int().min(1).max(3),stage:result,stake:z.number().int(),promised:z.number().int(),results:z.tuple([result,result,result])}).strict().superRefine((s,ctx)=>{
 const i=s.round-1;
 if(s.stake!==[10,20,100][i]||s.promised!==s.stake*2||s.stage!==s.results[i]||s.results.slice(i+1).some(r=>r!=='none')||
   s.results.slice(0,i).some(r=>r==='none'||r==='offered')||s.results.slice(0,2).includes('taken')||s.results[2]==='paid')
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid native sun exchange receipt'});
});
