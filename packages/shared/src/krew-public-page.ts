/** Trusted, static copy shared by the initial HTML and React's mounted page.
 * Keep this about the live game, not the separate test environment.
 */
/** Only the public entrance: never turn a test, room or arbitrary URL into a share link. */
export function getKrewPublicPath(gamePath: unknown): "/krew" | null {
  return gamePath === "/krew" || gamePath === "/krew/" ? "/krew" : null;
}

export const KREW_PREVIEW_IMAGE = {
  path: "/krew-cover-595f3b9d.jpg",
  width: 1983,
  height: 793,
  alt: "Krew.io cover art with pirate ships sailing past tropical cliffs at sunset.",
} as const;

export const KREW_ABOUT_HTML = `<article id="krew-about" class="krew-about" aria-labelledby="krew-about-title">
  <header><p class="krew-eyebrow">Play in your browser</p><h1 id="krew-about-title">Krew.io</h1>
  <p class="krew-intro">A free online multiplayer pirate game. Captain a ship or join a crew, fire cannons, fish, trade and battle other players on the open sea.</p></header>
  <figure class="krew-scene"><img src="${KREW_PREVIEW_IMAGE.path}" width="${KREW_PREVIEW_IMAGE.width}" height="${KREW_PREVIEW_IMAGE.height}" alt="${KREW_PREVIEW_IMAGE.alt}" loading="lazy" decoding="async"><figcaption>Set sail in Krew.io.</figcaption></figure>
  <div class="krew-about-grid">
    <section><h2>Make your own voyage</h2><p>Krew.io, also known as Krew IO, is a 3D browser game where players share a ship and work together. Explore islands, earn gold and trade for a better ship. Sail with friends, meet a new crew or challenge rival captains.</p><p>Choose your next move: cast a line, visit an island to trade, or get your cannons ready for a fight. A larger ship gives your crew more room, but teamwork and aim still matter.</p></section>
    <section><h2>How to play</h2><p>Move with WASD and use your mouse to aim. Select your cannon, fishing rod or spyglass with 1, 2 or 3. The in-game help explains the rest of the controls.</p><h2>Fish, trade and upgrade</h2><p>Cast your rod between battles, then visit island traders to sell your catch and trade goods. Save your gold for a better ship, make room for your crew and head out together for the next fight.</p></section>
  </div>
</article>`;

/** One loader for the initial HTML and for React while the frame boots: the
 * swap between them must not be visible. Same ring as the app splash, in this
 * page's palette; the text is for screen readers and crawlers. */
export const KREW_LOADING_HTML = `<div class="krew-initial-loading" role="status"><span class="krew-loading-ring" aria-hidden="true"></span><span class="krew-sr-only">Loading Krew.io…</span></div>`;

// Public copy is readable from the menu. The host locks this actual scroll
// surface during gameplay: frame input cannot be cancelled by parent handlers.
export const KREW_PAGE_CSS = `
.krew-public-page{position:fixed;inset:0;overflow-y:auto;background:#101a22;color:#edf1ed;overscroll-behavior:none}
.krew-public-page[data-playing="true"]{overflow:hidden;overflow:clip}
.krew-game-stage{position:relative;height:100vh;height:100dvh;background:#101a22}
.krew-initial-loading{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.krew-loading-ring{width:38px;height:38px;border-radius:50%;border:3px solid rgba(190,203,209,.18);border-top-color:#becbd1;animation:krew-spin .8s linear infinite}
@keyframes krew-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.krew-loading-ring{animation-duration:1.8s}}
.krew-sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.krew-about{box-sizing:border-box;max-width:980px;margin:auto;padding:72px 28px 88px;font:17px/1.75 system-ui,sans-serif;color:#b9c9ce}
.krew-about h1{margin:0 0 16px;font-size:42px;line-height:1.15;color:#fff}
.krew-about h2{margin:24px 0 8px;font-size:21px;line-height:1.4;color:#edf1ed}
.krew-about p{margin:0 0 16px}
.krew-about .krew-eyebrow{color:#a7cfcc;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.krew-about .krew-intro{max-width:720px;font-size:21px;color:#dde7e6}
.krew-scene{margin:28px 0 12px}
.krew-scene img{display:block;width:100%;height:auto;border-radius:8px}
.krew-scene figcaption{margin-top:8px;font-size:14px;color:#b9c9ce}
.krew-about-grid{display:grid;grid-template-columns:1fr 1fr;gap:44px}
@media(max-width:640px){.krew-about{padding:40px 24px}.krew-about-grid{grid-template-columns:1fr;gap:0}}
`;
