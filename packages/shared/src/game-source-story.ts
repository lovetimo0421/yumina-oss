import { z } from 'zod';

const tick=z.number().int().min(0).max(4_294_967_295);
const revision=z.number().int().min(0).max(1_000_000);
const eventSequence=z.number().int().min(1).max(1_000_000);
const selection=z.union([z.literal(-1),z.literal(0),z.literal(1)]);
export const sourceEventKindSchema=z.enum(['fixed','select','handle']);
export type SourceEventKind=z.infer<typeof sourceEventKindSchema>;
export function sourceEventKindMatches(id:number,kind:SourceEventKind):boolean {
 return kind==='select'?id<0:id>0;
}
// Only source1-5's authored routes and their traced dynamic children. F15010
// does not exist; F15013 and H15001 have no evidenced active caller.
const source15Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([100,103,12004,15001,15002,15003,15004,15005,15006,15007,15008,15009,
  15011,15012,15014,15015,15016,15017,15018,15019,15020,15021,15022,15023,
  2005,2006,2007,2008,2009,2010,2011,2012,3004]),
 select:new Set([2002,15002]),
 handle:new Set([2001,2002,2003,2007,2008,2009,2010,2011,2012,2013,15002,15003,15004,15005]),
};
export function source15EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source15Events[kind].has(Math.abs(id));
}
// Source1-6's authored schedule and traced choice/tutorial children. H3015
// (bucket attack) is not the reached F3015 (one additional bite).
const source16Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([104,2010,2011,3013,3014,3015,16001,16002,16003,16004,16005,16006]),
 select:new Set([2001,3003,3006,16001,16002,16003]),
 handle:new Set([2003,2011,2012,3001,3003,16001,16002,16003]),
};
export function source16EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source16Events[kind].has(Math.abs(id));
}
// Source1-7's reached schedule and children, not every row in the source tables.
const source17Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([101,104,105,200,...Array.from({length:16},(_,i)=>17001+i)]),
 select:new Set(Array.from({length:13},(_,i)=>17001+i)),
 handle:new Set([17001,17002,17003,3001]),
};
export function source17EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source17Events[kind].has(Math.abs(id));
}
// Source1-8 excludes F18008, whose body has no reached source caller.
const source18Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([104,105,106,2002,...Array.from({length:16},(_,i)=>18001+i).filter(id=>id!==18008)]),
 select:new Set([18001,18002,18003,18004]),
 handle:new Set([1001,3001,3002,18001,18002,18003,18004,18005,18006,18007]),
};
export function source18EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source18Events[kind].has(Math.abs(id));
}
// Source1-9 has no F19025. Only authored schedule rows and reached children.
const source19Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([100,102,103,104,105,106,11008,1001,2002,2003,2005,2006,2007,3001,3003,3004,3006,3007,3010,3014,
  ...Array.from({length:32},(_,i)=>19001+i).filter(id=>id!==19025)]),
 select:new Set([2002,19001,19002,19003]),
 handle:new Set([1001,2002,2003,19001]),
};
export function source19EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source19Events[kind].has(Math.abs(id));
}
// Source1-10 uses source row40149, not a continuation of the40153..40157 range.
// Shared actions are reached fixed owners; similarly numbered table handles are not.
const source110Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([104,105,3001,3003,3014,10001,10002,10003,...Array.from({length:11},(_,i)=>10006+i)]),
 select:new Set(Array.from({length:11},(_,i)=>10001+i)),
 handle:new Set(),
};
export function source110EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source110Events[kind].has(Math.abs(id));
}
// Source2-1: F21001, S21001 and H21001 are separate reached owners.
const source21Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,106,202,...Array.from({length:21},(_,i)=>21001+i)]),
 select:new Set([1016,2007,21001,21002]),
 handle:new Set([2012,21001]),
};
export function source21EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source21Events[kind].has(Math.abs(id));
}
// Source2-2 uses distinct fixed/select/handle owners, including direct speech.
const source22Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,103,104,106,107,2001,2002,2003,2006,3003,...Array.from({length:23},(_,i)=>22001+i)]),
 select:new Set([22001,22002,22003,22004,22005]),
 handle:new Set([2001,2002,2003,2006,3003,22001,22002,22003,22004]),
};
export function source22EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source22Events[kind].has(Math.abs(id));
}
// Source2-3: only reached native fixed/select/handle owners; F23002 is absent.
const source23Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,106,107,2002,2003,2007,2011,3003,3007,3010,...Array.from({length:36},(_,i)=>23001+i).filter(id=>id!==23002)]),
 select:new Set([23001,23002,23003,23004,23005,23006]),
 handle:new Set([23001,23002,23003]),
};
export function source23EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source23Events[kind].has(Math.abs(id));
}
// Source2-4 schedule and traced callbacks; absent F24016/F24021 and unrelated
// common numeric identities are intentionally not admitted.
const source24Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,106,107,2002,2003,2007,2011,3006,...Array.from({length:29},(_,i)=>24001+i).filter(id=>id!==24016&&id!==24021)]),
 select:new Set(Array.from({length:9},(_,i)=>24001+i)),
 handle:new Set([2001,2003,2006,3001,3003,3008,...Array.from({length:11},(_,i)=>24001+i)]),
};
export function source24EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {
 return kind!==undefined&&sourceEventKindMatches(id,kind)&&source24Events[kind].has(Math.abs(id));
}
// Source2-5 typed schedule and reached common callbacks; no future lookups.
const source25Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,105,106,107,...Array.from({length:18},(_,i)=>25001+i)]),
 select:new Set(Array.from({length:10},(_,i)=>25001+i)),
 handle:new Set([3001,25001,25002,25003,25004]),
};
export function source25EventAllowed(id:number,kind:SourceEventKind|undefined):boolean {return kind!==undefined&&sourceEventKindMatches(id,kind)&&source25Events[kind].has(Math.abs(id));}
const source26Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,2002,2003,2004,...Array.from({length:32},(_,i)=>26001+i).filter(id=>id!==26019&&id!==26020)]),
 select:new Set([2004,...Array.from({length:8},(_,i)=>26001+i)]),
 handle:new Set([2003,2006,2007,2011,2012,...Array.from({length:7},(_,i)=>26001+i)]),
};
export function source26EventAllowed(id:number,kind:SourceEventKind|undefined):boolean{return kind!==undefined&&sourceEventKindMatches(id,kind)&&source26Events[kind].has(Math.abs(id));}
export function source26NumericBounds(key:number):{min:0|1;max:10|1000|2000;step:1|50}|undefined {
 return [-26001,-26006,-26007].includes(key)?{min:0,max:2000,step:50}:key===-26002?{min:0,max:1000,step:50}:[-26003,-26004,-26005].includes(key)?{min:1,max:10,step:1}:undefined;
}
const source27Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,104,105,2007,3001,3002,3006,3007,3010,10016,23019,23035,25001,102007,...Array.from({length:22},(_,i)=>27001+i).filter(id=>id!==27021),27031,27032,27033,27034,27035]),
 select:new Set([2003,...Array.from({length:8},(_,i)=>27001+i)]),handle:new Set([2005,25003,27001]),
};
export function source27EventAllowed(id:number,kind:SourceEventKind|undefined):boolean{return kind!==undefined&&sourceEventKindMatches(id,kind)&&source27Events[kind].has(Math.abs(id));}
export function source27NumericBounds(key:number):{min:0|1;max:10|1000|2000;step:1|50}|undefined {
 return key===-27001?{min:1,max:10,step:1}:key===-27006?{min:0,max:2000,step:50}:key===-27008?{min:0,max:1000,step:50}:undefined;
}
// Prepared source2-8 protocol: only declared schedule owners and reached callbacks.
const source28Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([102,103,104,105,27015,...Array.from({length:20},(_,i)=>28001+i)]),
 select:new Set(Array.from({length:11},(_,i)=>28001+i)),handle:new Set([3001,28001,28002]),
};
export function source28EventAllowed(id:number,kind:SourceEventKind|undefined):boolean{return kind!==undefined&&sourceEventKindMatches(id,kind)&&source28Events[kind].has(Math.abs(id));}
export function source28NumericBounds(key:number):{min:0|1;max:4|1000;step:1|100}|undefined {
 return key===-28002?{min:1,max:4,step:1}:key===-28004?{min:0,max:1000,step:100}:undefined;
}
const source28NumericSchema=z.object({value:z.number().int().min(0).max(1000),min:z.union([z.literal(0),z.literal(1)]),max:z.union([z.literal(4),z.literal(1000)]),step:z.union([z.literal(1),z.literal(100)])}).strict();
const source28ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:z.number().int().min(-28011).max(-28001)};
function numeric28Matches(key:number,n:z.infer<typeof source28NumericSchema>|undefined){const b=source28NumericBounds(key);return !!b&&!!n&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source28CurrentChoiceSchema=z.object({...source28ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source28NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if(source28NumericBounds(c.eventKey)?c.kind!=='numeric'||!numeric28Matches(c.eventKey,c.numeric):c.kind!=='binary'||c.numeric!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source28 input must match the current authored row'});
});
export function source110NumericBounds(key:number):{min:0;max:number;step:number}|undefined {
 return key===-10008?{min:0,max:10000,step:100}:[-10009,-10010].includes(key)?{min:0,max:20,step:1}:undefined;
}
export function source21NumericBounds(key:number):{min:0;max:1000;step:50}|undefined {
 return [-1016,-2007].includes(key)?{min:0,max:1000,step:50}:undefined;
}
const source110Key=z.union([z.literal(-10008),z.literal(-10009),z.literal(-10010)]);
const source21Key=z.union([z.literal(-1016),z.literal(-2007)]);
const source110ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:source110Key};
const source21ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:source21Key};
const sourceEarlyNumericSchema=z.object({value:z.number().int().min(0).max(10000),min:z.literal(0),max:z.number().int(),step:z.number().int().positive()}).strict();
function numericEarlyMatches(key:number,n:z.infer<typeof sourceEarlyNumericSchema>){const b=source110NumericBounds(key)??source21NumericBounds(key);return !!b&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source110CurrentChoiceSchema=z.object({...source110ChoiceIdentity,kind:z.literal('numeric'),numeric:sourceEarlyNumericSchema}).strict().refine(c=>numericEarlyMatches(c.eventKey,c.numeric),'Source110 numeric bounds must match the authored row');
export const source21CurrentChoiceSchema=z.object({...source21ChoiceIdentity,kind:z.literal('numeric'),numeric:sourceEarlyNumericSchema}).strict().refine(c=>numericEarlyMatches(c.eventKey,c.numeric),'Source21 numeric bounds must match the authored row');
export function source22NumericBounds(key:number):{min:0|1;max:10|20;step:1}|undefined {
 return key===-22003?{min:1,max:10,step:1}:key===-22005?{min:0,max:20,step:1}:undefined;
}
const source22Key=z.union([z.literal(-22003),z.literal(-22005)]);
const source22ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:source22Key};
const source22NumericSchema=z.object({value:z.number().int().min(0).max(20),min:z.union([z.literal(0),z.literal(1)]),max:z.union([z.literal(10),z.literal(20)]),step:z.literal(1)}).strict();
function numeric22Matches(key:number,n:z.infer<typeof source22NumericSchema>){const b=source22NumericBounds(key);return !!b&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source22CurrentChoiceSchema=z.object({...source22ChoiceIdentity,kind:z.literal('numeric'),numeric:source22NumericSchema}).strict().refine(c=>numeric22Matches(c.eventKey,c.numeric),'Source22 numeric bounds must match the authored row');
export function sourceNumericAmountAllowed(key:number,value:unknown):value is number {
 const n=[-25009,-25010].includes(key)?{min:0,max:1000,step:50}:source110NumericBounds(key)??source21NumericBounds(key)??source22NumericBounds(key)??source26NumericBounds(key)??source27NumericBounds(key)??source28NumericBounds(key)??source29NumericBounds(key)??source210NumericBounds(key);
 return !!n&&typeof value==='number'&&Number.isInteger(value)&&value>=n.min&&value<=n.max&&(value-n.min)%n.step===0;
}
const source26NumericSchema=z.object({value:z.number().int().min(0).max(2000),min:z.union([z.literal(0),z.literal(1)]),max:z.union([z.literal(10),z.literal(1000),z.literal(2000)]),step:z.union([z.literal(1),z.literal(50)])}).strict();
const source26ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:z.union([z.number().int().min(-26008).max(-26001),z.literal(-2004)])};
function numeric26Matches(key:number,n:z.infer<typeof source26NumericSchema>|undefined){const bounds=source26NumericBounds(key);return !!bounds&&!!n&&n.min===bounds.min&&n.max===bounds.max&&n.step===bounds.step&&sourceNumericAmountAllowed(key,n.value);}
export const source26CurrentChoiceSchema=z.object({...source26ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source26NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if(c.eventKey===-26008||c.eventKey===-2004?c.kind!=='binary'||c.numeric!==undefined:c.kind!=='numeric'||!numeric26Matches(c.eventKey,c.numeric))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source26 numeric bounds or choice kind do not match the authored row'});
});
const source27ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:z.union([z.number().int().min(-27008).max(-27001),z.literal(-2003)])};
function numeric27Matches(key:number,n:z.infer<typeof source26NumericSchema>|undefined){const b=source27NumericBounds(key);return !!b&&!!n&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source27CurrentChoiceSchema=z.object({...source27ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source26NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if(source27NumericBounds(c.eventKey)?c.kind!=='numeric'||!numeric27Matches(c.eventKey,c.numeric):c.kind!=='binary'||c.numeric!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source27 input must match the current authored row'});
});
// Source2-9: exact Rules::ValidEventKey owners, including reused callbacks.
const source29Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([109, 102, 103, 104, 105, 106, 107, 2002, 2003, 3003, 21014, 22010, 22013, 25010, 26001, 26021, 26022, 26023, 26024, 26029, 27031, 27033, 27034, 27035, 28012, 29001, 29002, 29003, 29004, 29005, 29006, 29007, 29011, 29012, 29013, 29014, 29015, 29016, 29017, 29021, 29022, 29023, 29024, 29025, 29026, 29027, 29031, 29032, 29033, 29034, 29035, 29036, 29041, 29042, 29043, 29044, 29045, 29046, 29047, 29048, 29049, 29050, 29052, 29053, 29061, 29062, 29063, 29064]),select:new Set([29006, 29005, 29004, 29003, 29002, 29001, 27008, 26001, 3003, 2003, 2002]),handle:new Set([2002, 2003, 3003, 26001, 26007, 29001, 29002, 29003, 29004, 29005, 29006, 29007, 29008, 29009, 29010, 29011]),
};
export function source29EventAllowed(id:number,kind:SourceEventKind|undefined):boolean{return kind!==undefined&&sourceEventKindMatches(id,kind)&&source29Events[kind].has(Math.abs(id));}
export function source29NumericBounds(key:number):{min:0|1;max:10|1000|2000;step:1|50}|undefined {
 return key===-29006?{min:1,max:10,step:1}:key===-27008?{min:0,max:1000,step:50}:key===-26001?{min:0,max:2000,step:50}:undefined;
}
const source29ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:z.union([z.number().int().min(-29006).max(-29001),z.literal(-27008),z.literal(-26001),z.literal(-2002),z.literal(-2003),z.literal(-3003)])};
function numeric29Matches(key:number,n:z.infer<typeof source26NumericSchema>|undefined){const b=source29NumericBounds(key);return !!b&&!!n&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source29CurrentChoiceSchema=z.object({...source29ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source26NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if(source29NumericBounds(c.eventKey)?c.kind!=='numeric'||!numeric29Matches(c.eventKey,c.numeric):c.kind!=='binary'||c.numeric!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source29 input must match the current authored row'});
});
// Source2-10 current displayed child choice keeps its parent's native token.
const source210Events:Record<SourceEventKind,ReadonlySet<number>>={
 fixed:new Set([100,101,102,103,104,105,106,107,108,109,20001,20002,20051,20004,20052,20005,20053,20006,20054,20055,20007,20056,20008,20057,20009,20058,20059,20010,20011,20060,20012,20013,20061,20071,20072,20073,20074,20075,20076,20077,20078,20079,20080,20081,20082,20083,20084]),
 select:new Set([20001,20003,20004,20005,20051,20053,20054,20055,20071,20073,20074,20075,20076]),
 handle:new Set([20001,20002,20003,20004]),
};
export function source210EventAllowed(id:number,kind:SourceEventKind|undefined):boolean{return kind!==undefined&&sourceEventKindMatches(id,kind)&&source210Events[kind].has(Math.abs(id));}
export function source210NumericBounds(key:number):{min:0;max:300|1000|2000;step:50|100}|undefined {
 return key===-20003?{min:0,max:300,step:50}:[-20053,-20073].includes(key)?{min:0,max:1000,step:50}:[-20004,-20054,-20074].includes(key)?{min:0,max:2000,step:100}:undefined;
}
const source210Key=z.number().int().refine(key=>source210EventAllowed(key,'select'),'Exact source210 selection required');
const source210ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:source210Key};
const source210NumericSchema=z.object({value:z.number().int().min(0).max(2000),min:z.literal(0),max:z.union([z.literal(300),z.literal(1000),z.literal(2000)]),step:z.union([z.literal(50),z.literal(100)])}).strict();
function numeric210Matches(key:number,n:z.infer<typeof source210NumericSchema>|undefined){const b=source210NumericBounds(key);return !!b&&!!n&&n.min===b.min&&n.max===b.max&&n.step===b.step&&sourceNumericAmountAllowed(key,n.value);}
export const source210CurrentChoiceSchema=z.object({...source210ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source210NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if(source210NumericBounds(c.eventKey)?c.kind!=='numeric'||!numeric210Matches(c.eventKey,c.numeric):c.kind!=='binary'||c.numeric!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source210 input must match the displayed authored choice'});
});
// Source3-1 has concurrent scene owners. Strings preserve every uint64 bit.
export const source31Uint64Schema=z.string().regex(/^[1-9]\d{0,19}$/).refine(v=>/^[1-9]\d{0,19}$/.test(v)&&BigInt(v)<=18446744073709551615n,'Canonical positive uint64 required');
const source31Revision=z.number().int().min(0).max(1_000_000_000);
const source31Key=z.number().int().min(-31005).max(-31001);
const source31Identity={epoch:z.number().int().min(1).max(2_147_483_647),sceneRevision:source31Revision.min(1),storyRevision:source31Revision,eventKey:source31Key,owner:source31Uint64Schema,choiceRevision:source31Uint64Schema};
export const source31CurrentChoiceSchema=z.object({...source31Identity,kind:z.literal('binary'),eventToken:z.never().optional(),numeric:z.never().optional()}).strict();
const source31Rows:Record<number,readonly [readonly [string,string],readonly [string,string],readonly [string,string]]>={
 31001:[["Quick, get me out of here!","你快救我上来。"],["Help him out","救他上来"],["No","不救"]],
 31002:[["But I still have a gold shovel and a diamond shovel. Which one do you want?","但我还有金铲和钻石铲，你要哪个？"],["Gold","金"],["Diamond","钻"]],
 31003:[["I'll sell you my spare shovel for just 50 sun?","我把备用铲子卖你，只要50阳光？"],["Pay 50 sun","支付50阳光"],["Decline","拒绝"]],
 31004:[["I'll sell you my spare shovel for just 500 sun?","我把备用铲子卖你，只要500阳光？"],["Pay 500 sun","支付500阳光"],["Decline","拒绝"]],
 31005:[["Have you seen my brother Dave?","你有看见我弟弟戴夫吗？"],["Yes","看见了"],["No","没看见"]],
};
export function source31ChoiceText(key:number,locale:string){
 if(!Number.isInteger(key)||key> -31001||key< -31005||(locale!=='en'&&locale!=='zh'))return undefined;
 const row=source31Rows[-key]!,language=locale==='zh'?1:0;
 return {prompt:row[0][language],options:[{value:0 as const,label:row[1][language]},{value:1 as const,label:row[2][language]}]};
}
function valid31AnswerIdentity(c:{epoch?:number;sceneRevision:number;storyRevision?:number;eventKey?:number;owner?:string;choiceRevision?:string;eventToken?:number;sceneId:number}){
 const is31=(c.sceneId<=-31001&&c.sceneId>=-31005)||(c.eventKey!==undefined&&c.eventKey<=-31001&&c.eventKey>=-31005)||c.epoch!==undefined||c.owner!==undefined||c.choiceRevision!==undefined;
 return is31?c.sceneId===c.eventKey&&source31CurrentChoiceSchema.safeParse({epoch:c.epoch,sceneRevision:c.sceneRevision,storyRevision:c.storyRevision,eventKey:c.eventKey,owner:c.owner,choiceRevision:c.choiceRevision,eventToken:c.eventToken,kind:'binary'}).success:
  c.epoch===undefined&&c.owner===undefined&&c.choiceRevision===undefined&&c.sceneRevision<=1_000_000&&(c.storyRevision===undefined||c.storyRevision<=1_000_000);
}
export const source25AmountSchema=z.number().int().min(0).max(1000).multipleOf(50);
export const source25NumericSchema=z.object({value:source25AmountSchema,min:z.literal(0),max:z.literal(1000),step:z.literal(50)}).strict();
const source25ChoiceIdentity={sceneRevision:revision,storyRevision:revision,eventToken:eventSequence,eventKey:z.number().int().min(-25010).max(-25001)};
export const source25CurrentChoiceSchema=z.object({...source25ChoiceIdentity,kind:z.enum(['binary','numeric']),numeric:source25NumericSchema.optional()}).strict().superRefine((c,ctx)=>{
 if((c.eventKey<=-25009)!==(c.kind==='numeric')||(c.kind==='numeric')!==(c.numeric!==undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Choice input kind must match its source row'});
});
export function sourceStoryObservationsOnly(sourceLevel:number|undefined):boolean {
 return sourceLevel===40159||sourceLevel===40149||sourceLevel===40153||sourceLevel===40154||sourceLevel===40155||sourceLevel===40156||sourceLevel===40157||sourceLevel===40158||sourceLevel===40160||sourceLevel===40161||sourceLevel===40162||sourceLevel===40163||sourceLevel===40164||sourceLevel===40165||sourceLevel===40166||sourceLevel===40167;
}
const currentCard=z.object({
 sourceId:z.number().int().min(10).max(430).optional(),templateGeneration:z.string().regex(/^[1-9]\d{0,19}$/).refine(v=>/^[1-9]\d{0,19}$/.test(v)&&BigInt(v)<=18446744073709551615n).optional(),
 extra:z.boolean().optional(),
 packetIndex:z.number().int().min(0).max(11),seed:z.number().int().min(0).max(48),
 cost:z.number().int().min(-2_147_483_648).max(2_147_483_647),
 cooldownTicks:z.number().int().min(-1_000_000).max(4_294_967_295),remainingCooldownTicks:tick,tier:z.number().int().min(0).max(3),
}).strict();
const sunflower=z.object({packetPresent:z.boolean(),cost:z.number().int().min(0).max(1000),
 cooldown:z.number().int().min(1).max(100000),futureMaxHealth:z.number().int().min(1).max(1000000),
 futureProductionTicks:z.number().int().min(1).max(100000),selection12001:selection,selection12002:selection,
 futureOnly:z.literal(true),
}).strict();
// The model selects an engine-published candidate. It never supplies an effect,
// price, position, count, callback, or source code for the engine to execute.
export const sourceStoryEventSchema=z.union([z.literal(2001),z.literal(3001),z.literal(2005),z.literal(2007)]);
export const sourceStoryActionSchema=z.object({
 opportunityId:revision.min(1),revision,actionId:z.number().int().min(1).max(16),
}).strict();
export const source31GiftedLiliesSchema=z.object({granted:z.boolean(),planted:z.number().int().min(0).max(4096)}).strict()
 .refine(s=>s.granted||s.planted===0,'Planted gift requires the free packet');
const examMark=z.union([z.literal(0),z.literal(1)]);
// Correct/incorrect marks already shown on the paper, not answer identities.
export const source23ExamMarksSchema=z.tuple([examMark,examMark,examMark,examMark,examMark]);
export const source24ShoppingBillSchema=z.object({
 total:z.number().int().min(0).max(1125),paid:z.number().int().min(0).max(1125),
 purchases:z.tuple([z.boolean(),z.boolean(),z.boolean(),z.boolean(),z.boolean()]),
}).strict().refine(s=>s.paid<=s.total&&(s.paid===s.total||s.paid%100===0),'Bill payment follows the native collection chunks');
export const sourceStorySchema=z.object({
 version:z.literal(1),sourceLevel:z.number().int().min(1).max(1_000_000),revision:source31Revision,
 sceneId:z.number().int().min(-1_000_000).max(1_000_000),
 eventIdentityVersion:z.literal(1).optional(),sceneKind:sourceEventKindSchema.optional(),
 observationOnly:z.literal(true).optional(),giftedLilies:source31GiftedLiliesSchema.optional(),
 phase:z.enum(['idle','talking','choice','acting','stunned','won','lost']),
 hammerPending:z.boolean(),difficulty:z.number().int().min(1).max(4),
 pressure:z.enum(['source','balanced']),
 choice:z.union([source110CurrentChoiceSchema,source21CurrentChoiceSchema,source22CurrentChoiceSchema,source31CurrentChoiceSchema,source25CurrentChoiceSchema,source26CurrentChoiceSchema,source27CurrentChoiceSchema,source28CurrentChoiceSchema,source29CurrentChoiceSchema,source210CurrentChoiceSchema]).optional(),
 dave:z.union([z.object({hypnotized:z.boolean()}).strict(),z.object({hypnotized:z.boolean(),helmetTicks:tick,helmetColor:z.number().int().min(0).max(10)}).strict(),z.object({loanPrincipal:z.number().int().min(0).max(1000),returnVisits:z.number().int().min(0).max(5),blueLeave:z.boolean()}).strict()]).optional(),
 sunflower:sunflower.optional(),
 cards:z.array(currentCard).max(12)
  .refine(cards=>new Set(cards.map(c=>c.packetIndex)).size===cards.length,'Duplicate packet identity').optional(),
 guideRole:z.union([z.literal(0),z.literal(1),z.literal(2),z.literal(3)]).optional(),
 // Current physical state, not a promise made in an earlier dialogue.
 houseRuined:z.boolean().optional(),
 // Source 2-7 exports this only during the announced health action. It is
 // derived from native execution state, not inferred from dialogue/history.
 healthAction:z.object({status:z.enum(['pending','applied']),delta:z.union([
  z.literal(-299),z.literal(-149),z.literal(-100),z.literal(-50),z.literal(50),z.literal(150),z.literal(200),z.literal(300),
 ])}).strict().optional(),
 // Source 2-10's actual home-entry rule; independent of art or old dialogue.
 houseEntryProtected:z.boolean().optional(),
 walletHalfUnits:z.number().int().min(0).max(2_000_000).optional(),
 examReveal:z.object({sceneId:z.union([z.literal(23023),z.literal(23024)]),marks:source23ExamMarksSchema}).strict().optional(),
 // The saved native board supplies this only after all marks were revealed.
 // It carries no current dialogue, answer choices or action authority.
 examRecord:z.object({marks:source23ExamMarksSchema}).strict().optional(),
 shoppingBill:source24ShoppingBillSchema.optional(),
 events:z.array(z.object({level:z.number().int().min(1).max(50),
 eventId:z.number().int().min(-1_000_000).max(1_000_000),
  eventKind:sourceEventKindSchema.optional(),
  outcome:z.enum(['completed','interrupted','skipped']),effectCount:z.number().int().min(0).max(1_000_000),sequence:eventSequence.optional(),
 }).strict()).max(40),
 opportunity:z.object({id:revision.min(1),revision,expiresAtTick:tick,
  actions:z.array(z.object({id:z.number().int().min(1).max(16),eventId:sourceStoryEventSchema}).strict()).min(1).max(4)
   .refine(a=>new Set(a.map(v=>v.id)).size===a.length,'Duplicate action identity')
   .refine(a=>new Set(a.map(v=>v.eventId)).size===a.length,'Duplicate authored action'),
 }).strict().optional(),
}).strict().superRefine((s,ctx)=>{
 if(s.healthAction&&(s.sourceLevel!==40165||s.sceneKind!=='fixed'||s.sceneId!==27034||
    !['talking','acting'].includes(s.phase)||s.hammerPending||
    (s.healthAction.status==='applied'&&s.healthAction.delta<0)))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['healthAction'],message:'Health action observation belongs to the current source27 health event'});
 if(s.houseEntryProtected!==undefined&&(s.sourceLevel!==40159||s.phase==='won'||s.phase==='lost'))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['houseEntryProtected'],message:'Current finale protection belongs to active source210'});
 if(s.houseRuined!==undefined&&(s.sourceLevel!==40165||s.phase==='won'||s.phase==='lost'))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['houseRuined'],message:'Current house observation belongs to active source27'});
 if(s.examRecord!==undefined&&(s.sourceLevel!==40161||(s.examReveal&&s.examRecord.marks.some((mark,i)=>mark!==s.examReveal!.marks[i]))))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['examRecord'],message:'Saved marks belong to source23 and must agree with the visible paper'});
 if(s.shoppingBill!==undefined&&(s.sourceLevel!==40162||s.shoppingBill.total!==Math.floor(
  s.shoppingBill.purchases.reduce((sum,p,i)=>sum+(p?(i+1)*50:0),0)*[0,8,10,12,15][s.difficulty]!/10)))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['shoppingBill'],message:'Bill must match this source24 purchase ledger and difficulty'});
 if(s.examReveal!==undefined&&(s.sourceLevel!==40161||s.sceneKind!=='handle'||
  s.sceneId!==23002||!['talking','acting'].includes(s.phase)))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['examReveal'],message:'Exam reveal requires the active source23 scoring routine'});
 if(s.sourceLevel===40168){
  const observation=s.observationOnly===true&&s.giftedLilies!==undefined&&s.sceneId===0&&s.phase==='idle'&&s.sceneKind===undefined&&s.choice===undefined;
  const choice=s.observationOnly===undefined&&s.giftedLilies===undefined&&s.sceneKind==='select'&&s.phase==='choice'&&
   source31CurrentChoiceSchema.safeParse(s.choice).success&&s.choice?.eventKey===s.sceneId;
  if(s.eventIdentityVersion!==1||(!observation&&!choice)||s.hammerPending||s.pressure!=='source'||s.events.length||
   s.cards!==undefined||s.dave!==undefined||s.walletHalfUnits!==undefined||s.sunflower!==undefined||s.guideRole!==undefined||s.opportunity!==undefined)
   ctx.addIssue({code:z.ZodIssueCode.custom,message:'Source31 requires an exact current binary choice or a separate observation-only Lily receipt'});
  return;
 }
 if(s.observationOnly!==undefined||s.giftedLilies!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Pool receipt belongs to source31 only'});
 if(s.revision>1_000_000)ctx.addIssue({code:z.ZodIssueCode.custom,path:['revision'],message:'Legacy source revision exceeds its bound'});
 const source210=s.sourceLevel===40159,source29=s.sourceLevel===40167,source28=s.sourceLevel===40166,source27=s.sourceLevel===40165,source26=s.sourceLevel===40164,source25=s.sourceLevel===40163,source24=s.sourceLevel===40162,source23=s.sourceLevel===40161,source22=s.sourceLevel===40160,source21=s.sourceLevel===40158,source110=s.sourceLevel===40149,source16=s.sourceLevel===40154,source17=s.sourceLevel===40155,source18=s.sourceLevel===40156,source19=s.sourceLevel===40157;
 const observedOnly=sourceStoryObservationsOnly(s.sourceLevel),extended=s.sourceLevel===40152||observedOnly;
 const eventAllowed=source210?source210EventAllowed:source29?source29EventAllowed:source28?source28EventAllowed:source27?source27EventAllowed:source26?source26EventAllowed:source25?source25EventAllowed:source24?source24EventAllowed:source23?source23EventAllowed:source22?source22EventAllowed:source21?source21EventAllowed:source110?source110EventAllowed:source19?source19EventAllowed:source18?source18EventAllowed:source17?source17EventAllowed:source16?source16EventAllowed:source15EventAllowed;
 if(s.events.length>24&&!extended)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['events'],message:'Extended receipts require source1-4 through source2-4'});
 if(((source210||source28)&&s.cards!==undefined)||((source210||source28||source29)&&(s.dave!==undefined||s.walletHalfUnits!==undefined)))ctx.addIssue({code:z.ZodIssueCode.custom,message:'Native projections for this chapter are not integrated'});
 if(source110&&s.cards!==undefined)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source1-10 conveyor templates have no selected-packet projection'});
 if(s.guideRole!==undefined&&!(source29&&!['won','lost'].includes(s.phase)||source27&&s.guideRole!==2||(source22||source26)&&s.guideRole<=1))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['guideRole'],message:'Guide role must match the observed chapter cast: source2-2, source2-6, source2-7 or active source2-9'});
 s.cards?.forEach((card,index)=>{
  // olv scales remaining time separately from current duration. Prior changes
  // can leave a signed duration or remaining time greater than that duration.
  if((source22||source23||source24||source25||source26||source27||source29)?(Math.abs(card.cooldownTicks)>1_000_000||card.remainingCooldownTicks>1_000_000||Math.abs(card.cost)>1_000_000):
    (card.cooldownTicks<0||card.remainingCooldownTicks>card.cooldownTicks))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Card recharge exceeds its chapter bounds'});
  if(card.tier===3&&!source21&&!source22&&!source23&&!source24&&!source25&&!source26&&!source27&&!source29&&((s.sourceLevel!==40151&&s.sourceLevel!==40152)||card.seed>2))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index,'tier'],message:'Tier3 requires a supported source1-3 or source1-4 card'});
  if((source21||source22)&&![0,1,2,3,4,5,6,7,8,9,40].includes(card.seed))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'This night chapter supports only native seeds0..9 and40 as selected cards'});
  if(source24&&(!((card.seed>=0&&card.seed<=11)||card.seed===40)||!card.templateGeneration||
    card.sourceId!==(card.sourceId===125?125:(card.seed+1)*10)||(card.sourceId===125&&(card.seed!==11||card.tier!==0))))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source2-4 card requires its exact source and generation;125 is unupgraded native11'});
  if(!source22&&!source24&&!source25&&!source26&&!source27&&!source29&&(card.sourceId!==undefined||card.templateGeneration!==undefined))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Card source identity projection requires source2-4'});
  if(source22&&(card.sourceId!==undefined||card.templateGeneration!==undefined)&&(card.sourceId!==(card.seed+1)*10||!card.templateGeneration))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source22 card identity must include its exact source and generation'});
  if(!source29&&card.extra!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index,'extra'],message:'Explicit gift packet belongs to source29'});
  if(source23&&!((card.seed>=0&&card.seed<=10)||card.seed===40))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source2-3 supports ordinary seeds0..10 and40'});
  if(source16&&(card.seed>5||(card.seed>2&&card.tier>0)))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source1-6 supports six cards and upgrades only Peashooter, Sunflower and Cherry Bomb'});
  if(source18&&(card.seed>7||card.packetIndex>5||(card.seed>2&&card.tier>0)))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source1-8 selects six of eight cards and upgrades only Peashooter, Sunflower and Cherry Bomb'});
  if(source19&&(![0,1,2,3,4,5,6,7,40].includes(card.seed)||card.packetIndex>5||(card.seed>2&&card.tier>0)))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source1-9 selects six packets from nine cards; only Peashooter, Sunflower and Cherry Bomb support upgrades'});
  if(source17&&(card.seed>6||(card.seed>2&&card.tier>0)))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards',index],message:'Source1-7 supports seven cards and upgrades only Peashooter, Sunflower and Cherry Bomb'});
 });
 if(source16&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>8212)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source1-6 wallet exceeds native receipt bounds'});
 if(source17&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>64)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source1-7 wallet exceeds native receipt bounds'});
 if(source18&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>24)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source1-8 wallet exceeds its twelve physical diamonds'});
 if(source110&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>20)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source1-10 wallet exceeds its ten physical diamonds'});
 if(source22&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>22)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source2-2 wallet exceeds ten scheduled diamonds and one reached gift'});
 if(((s.choice&&!source110&&!source21&&!source22)||s.dave)&&!source25&&!source26&&!source27&&!source28&&!source29&&!source210)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Choice capability and Dave state require source2-5 or2-6'});
 if(s.choice&&((source110?!source110CurrentChoiceSchema.safeParse(s.choice).success:source21?!source21CurrentChoiceSchema.safeParse(s.choice).success:source22?!source22CurrentChoiceSchema.safeParse(s.choice).success:source210?!source210CurrentChoiceSchema.safeParse(s.choice).success:source29?!source29CurrentChoiceSchema.safeParse(s.choice).success:source28?!source28CurrentChoiceSchema.safeParse(s.choice).success:source27?!source27CurrentChoiceSchema.safeParse(s.choice).success:source26?!source26CurrentChoiceSchema.safeParse(s.choice).success:!source25CurrentChoiceSchema.safeParse(s.choice).success)||s.phase!=='choice'||s.sceneKind!=='select'||s.hammerPending||s.choice.eventKey!==s.sceneId))ctx.addIssue({code:z.ZodIssueCode.custom,path:['choice'],message:'Choice capability is not current'});
 if(s.dave&&(source27?Object.keys(s.dave).join(',')!=='hypnotized':source26?!('loanPrincipal' in s.dave):!('helmetTicks' in s.dave)))ctx.addIssue({code:z.ZodIssueCode.custom,path:['dave'],message:'Dave observations belong to another chapter'});
 if(source22&&s.cards&&new Set(s.cards.filter(c=>c.templateGeneration).map(c=>c.templateGeneration)).size!==s.cards.filter(c=>c.templateGeneration).length)ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source22 card generations must be distinct'});
 if(source22&&s.choice?.eventKey===-22003&&(!s.cards?.length||s.cards.some(c=>!c.templateGeneration||c.sourceId!==(c.seed+1)*10)))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source22 numeric card choice requires the current selected cards'});
 if(source29&&s.cards){const cards=s.cards,ordinary=cards.filter(c=>c.extra===false),gifts=cards.filter(c=>c.extra===true);
  if(cards.some(c=>typeof c.extra!=='boolean'||!c.templateGeneration||!/^[1-9]\d{0,9}$/.test(c.templateGeneration)||BigInt(c.templateGeneration)>4294967295n||
    (c.sourceId===155?(c.seed!==14||c.tier!==0||!c.extra):!((c.seed>=0&&c.seed<=15)||c.seed===40||c.seed===42)||c.sourceId!==(c.seed+1)*10))||
    new Set(cards.map(c=>c.templateGeneration)).size!==cards.length||new Set(ordinary.map(c=>c.sourceId)).size!==ordinary.length||
    ordinary.length>11||gifts.length>1||gifts.some(c=>![100,110,140,155].includes(c.sourceId??0)||c.packetIndex!==Math.max(...cards.map(v=>v.packetIndex))))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source29 requires current card generations and at most one final gift packet'});
 }
 if(source27&&s.cards){const cards=s.cards;
  if(cards.some(c=>!((c.seed>=0&&c.seed<=14)||c.seed===40)||!c.templateGeneration||(c.sourceId===155?(c.seed!==14||c.tier!==0):c.sourceId!==(c.seed+1)*10))||new Set(cards.map(c=>c.templateGeneration)).size!==cards.length||new Set(cards.map(c=>c.sourceId)).size!==cards.length)ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source27 cards require exact current source and generation; special155 uses seed14 and has no tiers'});
 }
 if(source27&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>1_000_000)ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source27 wallet exceeds native bounds'});
 if(source26&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>1_000_000)ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source26 wallet exceeds native bounds'});
 if(source26&&s.cards){const cards=s.cards,counts=new Map<number,number>();for(const c of cards)counts.set(c.seed,(counts.get(c.seed)??0)+1);
  const duplicates=[...counts].filter(([,n])=>n>1);
  if(cards.some(c=>!((c.seed>=0&&c.seed<=13)||c.seed===40)||c.sourceId!==(c.seed+1)*10||!c.templateGeneration)||new Set(cards.map(c=>c.templateGeneration)).size!==cards.length||(cards.length>0&&!counts.has(13))||duplicates.length>1||duplicates.some(([seed,n])=>n>2||![1,13].includes(seed)||cards.at(-1)?.seed!==seed))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source26 requires selected140 and at most one distinct extra140 or20'});
 }
 if(source25&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>1_000_000)ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source2-5 wallet exceeds native bounds'});
 if(source25&&s.cards){const cards=s.cards,hypnos=cards.filter(c=>c.seed===12),other=cards.filter(c=>c.seed!==12);
  if(cards.some(c=>!((c.seed>=0&&c.seed<=12)||c.seed===40)||c.sourceId!==(c.seed+1)*10||!c.templateGeneration)||new Set(cards.map(c=>c.templateGeneration)).size!==cards.length||new Set(other.map(c=>c.seed)).size!==other.length||hypnos.length>2||(cards.length>0&&!hypnos.length))ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source2-5 cards require selected130 and at most one independently owned extra130'});
 }
 if(source24&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>1_000_000)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source2-4 wallet exceeds native receipt bounds'});
 if(source24&&s.cards){
  const cards=s.cards,seeds=cards.map(c=>c.seed),ordinary=seeds.filter(seed=>seed!==11),special=cards.filter(c=>c.seed===11);
  if(new Set(cards.map(c=>c.templateGeneration)).size!==cards.length||new Set(ordinary).size!==ordinary.length||special.length>2||
    (cards.length>0&&!special.some(c=>c.sourceId===120))||special.filter(c=>c.sourceId===125).length>1||
    special.some(c=>c.sourceId===125&&c.packetIndex!==cards.length-1))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'Source2-4 permits one selected120 and one distinct extra120 or125 packet'});
 }
 if(source23&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>28)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source2-3 wallet exceeds thirteen scheduled diamonds and one reached gift'});
 if(source21&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>12)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source2-1 wallet exceeds five scheduled diamonds and one possible offer diamond'});
 if((source21||source22||source23)&&s.cards&&(s.cards.length>(source23?12:11)||new Set(s.cards.map(c=>c.seed)).size!==s.cards.length))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'This night chapter requires distinct selected source cards'});
 if(source19&&s.walletHalfUnits!==undefined&&s.walletHalfUnits>28)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['walletHalfUnits'],message:'Source1-9 wallet exceeds fourteen possible physical diamonds including event rewards'});
 if((source18||source19)&&s.cards&&s.cards.length>6)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['cards'],message:'This source chapter has six selected packets'});
 const typed=s.eventIdentityVersion===1;
 if((s.sourceLevel===40151||extended)&&!typed)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['eventIdentityVersion'],message:'This source chapter requires typed event identities'});
 if(typed?(s.sceneId===0?s.sceneKind!==undefined:!s.sceneKind||!sourceEventKindMatches(s.sceneId,s.sceneKind)):s.sceneKind!==undefined)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['sceneKind'],message:'Scene kind does not match its identity'});
 const sequenced=s.events.filter(e=>e.sequence!==undefined);
 if(sequenced.length&&(!typed||sequenced.length!==s.events.length))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['events'],message:'Sequenced events require one complete typed frame'});
 if((s.sourceLevel===40151||extended)&&s.events.length&&sequenced.length!==s.events.length)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['events'],message:'Live source chapter receipts require sequence'});
 if(observedOnly&&new Set(sequenced.map(e=>e.sequence)).size!==sequenced.length)
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['events'],message:'Observed-only chapter receipt tokens must be unique; array order is chronology'});
 if(!observedOnly&&sequenced.length===s.events.length)for(let i=1;i<s.events.length;i++)
  if(s.events[i]!.sequence!<=s.events[i-1]!.sequence!)
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['events',i,'sequence'],message:'Event sequence must be strictly increasing'});
 s.events.forEach((e,i)=>{
  if(observedOnly?(e.level!==(source210?20:source29?19:source28?18:source27?17:source26?16:source25?15:source24?14:source23?13:source22?12:source21?11:source110?10:source19?9:source18?8:source17?7:source16?6:5)||!eventAllowed(e.eventId,e.eventKind)):e.effectCount>999)
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['events',i],message:'Event exceeds this source chapter contract'});
  if(typed?(!e.eventKind||!sourceEventKindMatches(e.eventId,e.eventKind)):e.eventKind!==undefined)
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['events',i,'eventKind'],message:'Event kind does not match its identity'});
 });
 if(observedOnly){
  if(s.sceneId!==0&&!eventAllowed(s.sceneId,s.sceneKind))
   ctx.addIssue({code:z.ZodIssueCode.custom,path:['sceneId'],message:'Unknown observed-only chapter authored scene'});
  if(s.opportunity)ctx.addIssue({code:z.ZodIssueCode.custom,path:['opportunity'],message:'Observed-only chapter autonomous proposals are disabled'});
 }
 if(s.opportunity&&(s.phase!=='idle'||s.hammerPending||s.sceneId!==0||s.opportunity.revision!==s.revision))
  ctx.addIssue({code:z.ZodIssueCode.custom,path:['opportunity'],message:'Opportunity is not owned by the current idle scene'});
 if(s.sunflower){
  const f=s.sunflower,d=s.difficulty-1,factor=[.5,.3,.2,.1][d]!;
  const valid=s.sourceLevel===40150&&(f.selection12001>=0||f.selection12002>=0)&&
   f.cost===(f.selection12001===1?50-Math.trunc(50*factor):50)&&
   f.cooldown===(f.selection12001===0?Math.round(750*(1-factor)):750)&&
   f.futureMaxHealth===(f.selection12002===0?Math.round(300*(1+factor)):300)&&
   f.futureProductionTicks===(f.selection12002===1?Math.round(2400*(1-factor)):2400);
  if(!valid)ctx.addIssue({code:z.ZodIssueCode.custom,path:['sunflower'],message:'Sunflower facts do not match committed source choices'});
 }
});
export type SourceStory=z.infer<typeof sourceStorySchema>;
export type SourceStoryAction=z.infer<typeof sourceStoryActionSchema>;

// A player's free-text answer may select one of the two currently rendered
// authored branches. The native scene revision is separate from story revision.
export const sourceChoiceValueSchema=z.union([z.literal(0),z.literal(1)]);
export const sourceStoryChoiceSchema=z.object({
 sceneRevision:source31Revision,sceneId:z.number().int().min(-1_000_000).max(-1),
 storyRevision:source31Revision.optional(),epoch:source31Identity.epoch.optional(),owner:source31Uint64Schema.optional(),choiceRevision:source31Uint64Schema.optional(),eventToken:eventSequence.optional(),eventKey:z.union([source31Key,source210Key.refine(key=>!source210NumericBounds(key)),z.number().int().min(-25008).max(-25001),z.literal(-26008),z.literal(-2004),z.literal(-2003),z.literal(-2002),z.literal(-3003),z.number().int().min(-29005).max(-29001),z.union([z.literal(-27002),z.literal(-27003),z.literal(-27004),z.literal(-27005),z.literal(-27007)]),z.number().int().min(-28011).max(-28001).refine(id=>id!==-28002&&id!==-28004)]).optional(),
 prompt:z.string().trim().min(1).max(2000).optional(),
 options:z.array(z.object({value:sourceChoiceValueSchema,label:z.string().trim().min(1).max(300)}).strict()).length(2)
  .refine(options=>new Set(options.map(option=>option.value)).size===2,'Choice options must have distinct native values'),
}).strict().refine(valid31AnswerIdentity,'Choice identity belongs to another chapter or is incomplete');
export const sourceStoryNumericSchema=z.union([z.object({...source110ChoiceIdentity,sceneId:source110Key,prompt:z.string().trim().min(1).max(2000),numeric:sourceEarlyNumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numericEarlyMatches(c.eventKey,c.numeric),'Numeric110 exact row and limits required'),z.object({...source21ChoiceIdentity,sceneId:source21Key,prompt:z.string().trim().min(1).max(2000),numeric:sourceEarlyNumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numericEarlyMatches(c.eventKey,c.numeric),'Numeric21 exact row and limits required'),z.object({...source22ChoiceIdentity,sceneId:source22Key,prompt:z.string().trim().min(1).max(2000),numeric:source22NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric22Matches(c.eventKey,c.numeric),'Numeric22 exact row and limits required'),z.object({...source210ChoiceIdentity,sceneId:source210Key,prompt:z.string().trim().min(1).max(2000),numeric:source210NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric210Matches(c.eventKey,c.numeric),'Numeric210 exact displayed row and limits required'),z.object({...source25ChoiceIdentity,sceneId:z.union([z.literal(-25009),z.literal(-25010)]),prompt:z.string().trim().min(1).max(2000),numeric:source25NumericSchema}).strict(),z.object({...source26ChoiceIdentity,sceneId:z.number().int().min(-26007).max(-26001),prompt:z.string().trim().min(1).max(2000),numeric:source26NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric26Matches(c.eventKey,c.numeric),'Numeric26 exact row and limits required'),z.object({...source27ChoiceIdentity,sceneId:z.union([z.literal(-27001),z.literal(-27006),z.literal(-27008)]),prompt:z.string().trim().min(1).max(2000),numeric:source26NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric27Matches(c.eventKey,c.numeric),'Numeric27 exact row and limits required'),z.object({...source28ChoiceIdentity,sceneId:z.union([z.literal(-28002),z.literal(-28004)]),prompt:z.string().trim().min(1).max(2000),numeric:source28NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric28Matches(c.eventKey,c.numeric),'Numeric28 exact row and limits required'),z.object({...source29ChoiceIdentity,sceneId:z.union([z.literal(-29006),z.literal(-27008),z.literal(-26001)]),prompt:z.string().trim().min(1).max(2000),numeric:source26NumericSchema}).strict().refine(c=>c.sceneId===c.eventKey&&numeric29Matches(c.eventKey,c.numeric),'Numeric29 exact row and limits required')]);
export const sourceChoiceSchema=z.object({
 sceneRevision:source31Revision,sceneId:z.number().int().min(-1_000_000).max(-1),value:sourceChoiceValueSchema,
 storyRevision:source31Revision.optional(),epoch:source31Identity.epoch.optional(),owner:source31Uint64Schema.optional(),choiceRevision:source31Uint64Schema.optional(),eventToken:eventSequence.optional(),eventKey:z.union([source110Key,source21Key,source22Key,source31Key,source210Key,z.number().int().min(-25010).max(-25001),z.number().int().min(-26008).max(-26001),z.number().int().min(-27008).max(-27001),z.number().int().min(-28011).max(-28001),z.literal(-2004),z.literal(-2003),z.literal(-2002),z.literal(-3003),z.number().int().min(-29006).max(-29001)]).optional(),amount:z.number().int().min(0).max(10000).optional(),
}).strict().refine(valid31AnswerIdentity,'Reply identity belongs to another chapter or is incomplete').refine(c=>c.amount===undefined||sourceNumericAmountAllowed(c.eventKey??0,c.amount),'Reply amount must match its authored numeric row').refine(c=>!(source110NumericBounds(c.eventKey??0)||source21NumericBounds(c.eventKey??0)||source22NumericBounds(c.eventKey??0))||(c.value===0&&c.amount!==undefined),'Source110, source21 and source22 numeric replies require delivery marker zero');
