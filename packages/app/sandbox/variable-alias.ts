/**
 * Read a variable by its display name, not just its id.
 *
 * The session state bag is keyed by `Variable.id`, and the editor mints that id
 * as a `crypto.randomUUID()` the creator never sees (stores/editor.ts addVariable).
 * The engine already forgives the LLM for writing `[hunger: -30]` when the id is
 * a UUID — GameStateManager.resolveVariable() falls back name → id. The frontend
 * had no such fallback, so a HUD written as `api.variables.hunger` read undefined
 * forever and froze on its own `|| 100` default. That is silent: nothing throws,
 * the panel just stops agreeing with the story.
 *
 * So: same forgiveness, same direction. The id always wins — an alias is only
 * added for a name the bag has no own key for.
 *
 * Enumeration is deliberately NOT aliased. `ownKeys` stays the target's, so
 * `Object.keys(api.variables)` / spread / JSON.stringify still yield one entry
 * per variable. Cards that render the whole bag (34 of them on prod) must not
 * grow a duplicate row per stat.
 */

/** Cache keyed by the bag object so the proxy identity is as stable as the bag
 *  it wraps. Without this a fresh Proxy per assembleState() call would change
 *  `api.variables`'s identity on every streaming tick (~30Hz), busting every
 *  `useMemo([api.variables])` and `useEffect([api.variables])` inside cards. */
const proxyCache = new WeakMap<object, { idsByName: unknown; proxy: Record<string, unknown> }>();

export function withVariableNameAliases(
  bag: Record<string, unknown>,
  idsByName: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!idsByName) return bag;

  const cached = proxyCache.get(bag);
  if (cached && cached.idsByName === idsByName) return cached.proxy;

  const alias: Record<string, string> = {};
  for (const name in idsByName) {
    const id = idsByName[name];
    // A name that already IS a key of the bag belongs to some variable's id —
    // never shadow a real value with another variable's.
    if (!id || name === id || Object.prototype.hasOwnProperty.call(bag, name)) continue;
    alias[name] = id;
  }
  if (Object.keys(alias).length === 0) {
    proxyCache.set(bag, { idsByName, proxy: bag });
    return bag;
  }

  const proxy = new Proxy(bag, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in target) && alias[key] !== undefined) {
        return Reflect.get(target, alias[key]!, receiver);
      }
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      if (typeof key === "string" && !(key in target) && alias[key] !== undefined) {
        return alias[key]! in target;
      }
      return Reflect.has(target, key);
    },
  });
  proxyCache.set(bag, { idsByName, proxy });
  return proxy;
}
