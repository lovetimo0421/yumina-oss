// Small, framework-independent client for first-party games and parent bridges.
// A guest token is never an account login or permission to call an LLM.
export function createGameIdentity(options = {}) {
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  const base = options.base || "";
  let storage;
  try { storage = options.storage || globalThis.localStorage; } catch {}
  const key = "yumina_game_identity_v1", seenKey = "yumina_game_seen_guest";
  const read = k => { try { return storage?.getItem(k); } catch { return null; } };
  const write = (k,v) => { try { storage?.setItem(k,v); } catch {} };
  const valid = v => v && /^guest:[a-f0-9]{32}$/.test(v.guestId)
    && typeof v.guestToken === "string" && v.guestToken.length <= 160
    && Number.isFinite(v.expiresAt) && v.expiresAt > Date.now();
  const stored = () => { try { const v=JSON.parse(read(key)); return valid(v)?v:null; } catch { return null; } };
  let identity = stored(), pending = null;
  async function request(path,body) {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),4000);
    try {
      const response=await fetcher(base+"/api/game/"+path,{
        method:"POST",credentials:"include",headers:{"content-type":"application/json"},
        body:JSON.stringify(body),signal:controller.signal,
      });
      return response.ok ? await response.json() : null;
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  function adopt(value) {
    if(!valid(value))return null;
    identity={guestId:value.guestId,guestToken:value.guestToken,expiresAt:value.expiresAt};
    write(key,JSON.stringify(identity));return identity;
  }
  return {
    async get() {
      if(pending)return pending;
      // Always reconcile with the HttpOnly platform cookie once per get batch.
      // Cross-tab login may have rotated it since this instance was created.
      const prior=stored() || identity;
      pending=request("identity",{guestToken:prior?.guestToken || read("pvz_guest_token") || undefined})
        .then(v=>adopt(v)).finally(()=>{pending=null;});
      return pending;
    },
    current() { return stored() || identity; },
    async markGuestVisit() {
      const value=await this.get();
      if(value)write(seenKey,value.guestId);
      return value;
    },
    async link(accountId) {
      const previous=stored() || identity;
      if(!previous || read(seenKey)!==previous.guestId)return false;
      const result=await request("identity/link",{guestToken:previous.guestToken,accountId});
      if(!result)return false;
      if(result.nextGuest)adopt(result.nextGuest);
      if(read(seenKey)===previous.guestId)write(seenKey,"");
      return result.linked===true;
    },
  };
}
