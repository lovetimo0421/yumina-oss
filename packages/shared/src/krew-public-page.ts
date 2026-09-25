/** Trusted, static copy shared by the initial HTML and React's mounted page.
 * Keep this about the live game, not the separate test environment.
 */
export const KREW_ABOUT_HTML = `<article id="krew-about" class="krew-about" aria-labelledby="krew-about-title">
  <header><p class="krew-eyebrow">Play in your browser</p><h1 id="krew-about-title">Krew.io</h1>
  <p class="krew-intro">A free online multiplayer pirate game. Captain a ship or join a crew, fire cannons, fish, trade and battle other players on the open sea.</p></header>
  <div class="krew-about-grid">
    <section><h2>Make your own voyage</h2><p>Krew.io, also known as Krew IO, is a 3D browser game where players share a ship and work together. Explore islands, earn gold and trade for a better ship. Sail with friends, meet a new crew or challenge rival captains.</p><p>Choose your next move: cast a line, visit an island to trade, or get your cannons ready for a fight. A larger ship gives your crew more room, but teamwork and aim still matter.</p></section>
    <section><h2>How to play</h2><p>Move with WASD and use your mouse to aim. Select your cannon, fishing rod or spyglass with 1, 2 or 3. The in-game help explains the rest of the controls.</p><h2>Can I play for free?</h2><p>Yes. You can join as a guest and play directly in your browser without installing anything. The game above is the official Krew.io game, hosted on Yumina.</p></section>
  </div>
</article>`;

// A dedicated scroll surface keeps the existing full-screen app layout intact.
// No floating About button, extra HUD, or reduced game viewport.
export const KREW_PAGE_CSS = `
.krew-public-page{position:fixed;inset:0;overflow-y:auto;background:#101a22;color:#edf1ed;overscroll-behavior:none}
.krew-game-stage{position:relative;height:100vh;height:100dvh;background:#000}
.krew-initial-loading{height:100%;display:grid;place-items:center;color:#becbd1;font:16px system-ui,sans-serif}
.krew-about{box-sizing:border-box;max-width:980px;margin:auto;padding:72px 28px 88px;font:17px/1.75 system-ui,sans-serif;color:#b9c9ce}
.krew-about h1{margin:0 0 16px;font-size:42px;line-height:1.15;color:#fff}
.krew-about h2{margin:24px 0 8px;font-size:21px;line-height:1.4;color:#edf1ed}
.krew-about p{margin:0 0 16px}
.krew-about .krew-eyebrow{color:#a7cfcc;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.krew-about .krew-intro{max-width:720px;font-size:21px;color:#dde7e6}
.krew-about-grid{display:grid;grid-template-columns:1fr 1fr;gap:44px}
@media(max-width:640px){.krew-about{padding:40px 24px}.krew-about-grid{grid-template-columns:1fr;gap:0}}
`;
