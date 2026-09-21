// Published game packs use content-addressed directories and an uploader that
// refuses overwrites. Keep mutable/user-owned media on its deletion-aware TTL.
const IMMUTABLE_GAME_RESOURCE=/^worlds\/pvz-previews\/[0-9a-f]{64}\/(?:main\.pak|properties\/(?:default\.xml|Layout\.xml|partner\.xml(?:\.sig)?|partner_logo\.jpg))$/;
export function publicAssetCacheControl(key:string):string {
 return IMMUTABLE_GAME_RESOURCE.test(key)?'public, max-age=31536000, immutable':
  'public, max-age=0, s-maxage=300, must-revalidate';
}
