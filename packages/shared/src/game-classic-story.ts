import {z} from 'zod';
// Identifies one authored native offer. No model-defined terms or resource values.
const headChoice=z.object({kind:z.literal('head_prize'),wave:z.number().int().min(3).max(5)}).strict();
const doubleChoice=z.object({kind:z.literal('sun_double'),round:z.number().int().min(1).max(3),wave:z.number().int().min(6).max(12)}).strict();
const shuffleChoice=z.object({kind:z.literal('gift_shuffle'),wave:z.number().int().min(2).max(100),revision:z.number().int().min(1).max(10),stage:z.union([z.literal(1),z.literal(3),z.literal(4)]),opened:z.number().int().min(-1).max(2)}).strict();
export const classicStoryChoiceSchema=z.discriminatedUnion('kind',[headChoice,doubleChoice,shuffleChoice]);
const decision=z.union([z.literal(0),z.literal(1),z.null()]);
export const classicStoryAnswerSchema=z.discriminatedUnion('kind',[headChoice.extend({decision}),doubleChoice.extend({decision}),shuffleChoice.extend({decision:z.union([z.literal(0),z.literal(1),z.literal(3),z.literal(4),z.literal(5),z.literal(6),z.null()])})]);
export const giftShuffleSchema=z.object({stage:z.number().int().min(0).max(8),revision:z.number().int().min(0).max(10),opened:z.number().int().min(-1).max(2),picked:z.number().int().min(-1).max(2),swaps:z.number().int().min(0).max(242).optional(),prize:z.number().int().min(0).max(2).optional()}).strict().superRefine((s,ctx)=>{
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
