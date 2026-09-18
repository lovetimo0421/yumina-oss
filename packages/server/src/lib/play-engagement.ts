/** Atomic per-lease engagement accumulator. Inputs are server-awarded seconds;
 * the browser supplies only a recent trusted-input flag, never elapsed time.
 * A fresh/idle visit starts at zero. Old/replayed ticks cannot add time.
 * The resulting event is an engagement estimate, not a verified game move. */
export const PLAY_ENGAGEMENT_LUA = `
local now=tonumber(ARGV[1])
local delta=tonumber(ARGV[2])
local recent=ARGV[3]=='1'
local last=tonumber(redis.call('HGET',KEYS[1],'last') or '0')
if now<=last then return 0 end
local seconds=tonumber(redis.call('HGET',KEYS[1],'seconds') or '0')
local wasRecent=redis.call('HGET',KEYS[1],'input')=='1'
if not recent or not wasRecent or last==0 or now-last>90000 then seconds=0
else seconds=math.min(120,seconds+math.max(0,math.min(90,delta))) end
redis.call('HSET',KEYS[1],'last',now,'seconds',seconds,'input',ARGV[3])
redis.call('EXPIRE',KEYS[1],1800)
return seconds>=60 and 1 or 0
`;
