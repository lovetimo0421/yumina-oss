/** One foreground lease per account/surface. Elapsed time is server-owned;
 * replays, idle tabs, competing tabs and gaps cannot accelerate qualification. */
export const BROWSE_ENGAGEMENT_LUA = `
local now=tonumber(ARGV[1])
local lease=ARGV[2]
local seq=tonumber(ARGV[3])
local active=ARGV[4]=='1'
local evidence=tonumber(ARGV[5])
local last=tonumber(redis.call('HGET',KEYS[1],'last') or '0')
local owner=redis.call('HGET',KEYS[1],'lease')
if owner and owner~=lease and now-last<45000 then return 0 end
local oldseq=tonumber(redis.call('HGET',KEYS[1],'seq') or '0')
if owner==lease and seq<=oldseq then return 0 end
local seconds=tonumber(redis.call('HGET',KEYS[1],'seconds') or '0')
local inputs=tonumber(redis.call('HGET',KEYS[1],'inputs') or '0')
local prev=tonumber(redis.call('HGET',KEYS[1],'evidence') or '0')
local wasActive=redis.call('HGET',KEYS[1],'active')=='1'
if owner~=lease or not active or not wasActive or last==0 or now-last>45000 then
  seconds=0; inputs=0; prev=0
else seconds=math.min(120,seconds+math.max(0,now-last)/1000) end
if active and evidence>prev then inputs=math.min(2,inputs+1) end
redis.call('HSET',KEYS[1],'last',now,'lease',lease,'seq',seq,'seconds',seconds,'inputs',inputs,'evidence',evidence,'active',ARGV[4])
redis.call('EXPIRE',KEYS[1],180)
return seconds>=60 and inputs>=2 and 1 or 0
`;
