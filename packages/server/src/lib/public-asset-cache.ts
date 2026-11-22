// Published game packs use content-addressed directories and an uploader that
// refuses overwrites. Keep mutable/user-owned media on its deletion-aware TTL:
// five minutes at the edge (no purge exists, so this bounds how long a deleted
// account's media stays reachable) and five minutes in the browser. The edge
// sends Age, which the browser subtracts, so the two together still end about
// five minutes after the edge fetched it; before, max-age=0 made the browser
// re-ask for every cover on every page.
const IMMUTABLE_GAME_RESOURCE=/^worlds\/pvz-previews\/[0-9a-f]{64}\/(?:main\.pak|properties\/(?:default\.xml|Layout\.xml|partner\.xml(?:\.sig)?|partner_logo\.jpg))$/;
// Voice readouts are keyed by sha256(model|voice|text) and never rewritten.
const IMMUTABLE_TTS_AUDIO=/^tts\/[0-9a-f]{64}\.mp3$/;
export function publicAssetCacheControl(key:string):string {
 return IMMUTABLE_GAME_RESOURCE.test(key)||IMMUTABLE_TTS_AUDIO.test(key)?'public, max-age=31536000, immutable':
  'public, max-age=300, s-maxage=300, must-revalidate';
}
