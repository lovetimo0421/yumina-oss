/**
 * The runtime the four "form" parts share — cards to pick from, a question, a
 * popup, and list rows drawn as cards.
 *
 * These are emitted as a handful of helper components rather than inlined per
 * element, the same way `Img` and `Markdown` already are: a carousel has
 * pointer, keyboard and index state, a text field has a debounce, and writing
 * that out once per element would make the "export to code" file unreadable.
 * What IS per element — the options, their pictures, and above all the steps
 * each option runs — is still compiled to real code at the call site.
 *
 * Every default here is derived from the theme's own tokens (`--yc-*`, see
 * themes.ts), so a part dropped on a 素纸 card is paper and the same part on a
 * 夜色 card is night, with no style set on it at all. A creator's own style
 * fields arrive as inline styles and so win over these class rules.
 *
 * Kept free of backticks and `${` on purpose: it is spliced verbatim into the
 * generated file's template literal.
 */

/** Stylesheet for the parts. Scoped under the stage so it cannot reach the app. */
export const PARTS_CSS = String.raw`
@keyframes ypFade{from{opacity:0}to{opacity:1}}
@keyframes ypRise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
@keyframes ypIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
[data-ui-stage] .yp{--yp-accent:var(--yc-send-bg,#d9a13f);--yp-on-accent:var(--yc-send-fg,#1d1406);--yp-text:var(--yc-text,#f1ece4);--yp-ground:var(--yc-bg-solid,#15171d);--yp-muted:color-mix(in srgb,var(--yp-text) 64%,transparent);--yp-card:var(--yc-input-bg,color-mix(in srgb,var(--yp-text) 7%,var(--yp-ground)));--yp-card-solid:var(--yc-input-bg,color-mix(in srgb,var(--yp-text) 5%,var(--yp-ground)));--yp-line:color-mix(in srgb,var(--yp-text) 14%,transparent);--yp-radius:var(--yc-input-radius,14px);--yp-shade:rgba(0,0,0,.42);font-family:var(--yc-font,inherit);color:var(--yp-text);box-sizing:border-box;-webkit-tap-highlight-color:transparent}
[data-ui-stage] .yp :where(button,input,textarea){font:inherit;margin:0;letter-spacing:inherit}
[data-ui-stage] .yp *,[data-ui-stage] .yp *::before,[data-ui-stage] .yp *::after{box-sizing:border-box}
[data-ui-stage]:has(.yp-scrim)::after{content:"";position:absolute;inset:0;z-index:0;background:rgba(6,8,12,.56);animation:ypFade .22s ease both;pointer-events:none}
[data-ui-stage] .yp-choice{display:flex;flex-direction:column;gap:10px}
[data-ui-stage] .yp-scroll{flex:1;min-height:0;display:flex;flex-direction:column;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--yp-line) transparent;padding:4px 4px 6px;margin:-4px -4px 0}
[data-ui-stage] .yp-grid{display:grid;align-content:start}
[data-ui-stage] .yp-scroll>.yp-grid{flex:1 0 auto;grid-auto-rows:minmax(min-content,1fr)}
[data-ui-stage] .yp-stack{display:flex;flex-direction:column}
[data-ui-stage] .yp-card{position:relative;display:flex;flex-direction:column;align-items:stretch;text-align:left;padding:0;border:1px solid var(--yp-line);border-radius:var(--yp-radius);background:var(--yp-card);color:var(--yp-text);overflow:hidden;cursor:pointer;min-width:0;box-shadow:0 1px 0 color-mix(in srgb,var(--yp-text) 6%,transparent) inset,0 12px 28px -20px var(--yp-shade);transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .18s ease,box-shadow .2s ease,opacity .18s ease}
[data-ui-stage] div.yp-card{cursor:default}
[data-ui-stage] button.yp-card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--yp-accent) 55%,var(--yp-line));box-shadow:0 1px 0 color-mix(in srgb,var(--yp-text) 6%,transparent) inset,0 18px 34px -20px var(--yp-shade)}
[data-ui-stage] button.yp-card:active{transform:translateY(0) scale(.985);transition-duration:.08s}
[data-ui-stage] .yp :where(.yp-card,.yp-chip,.yp-confirm,.yp-step,.yp-x,.yp-nav,.yp-dot,.yp-rowbtn):focus-visible{outline:2px solid var(--yp-accent);outline-offset:2px}
[data-ui-stage] .yp-card[aria-pressed="true"]{border-color:var(--yp-accent);box-shadow:0 0 0 1px var(--yp-accent),0 14px 30px -16px color-mix(in srgb,var(--yp-accent) 70%,transparent)}
[data-ui-stage] .yp-card[aria-disabled="true"]{opacity:.45;cursor:default;transform:none}
[data-ui-stage] .yp-enter{animation:ypIn .34s cubic-bezier(.2,.8,.2,1) both}
[data-ui-stage] .yp-media{position:relative;display:block;width:100%;flex:1 0 auto;overflow:hidden;background:color-mix(in srgb,var(--yp-text) 8%,var(--yp-ground))}
[data-ui-stage] .yp-media img{display:block;transition:transform .5s cubic-bezier(.2,.8,.2,1),opacity .22s ease}
[data-ui-stage] button.yp-card:hover .yp-media img{transform:scale(1.04)}
[data-ui-stage] .yp-tile{--yp-h:color-mix(in oklab,var(--yp-hue,#6f7fb0) 80%,var(--yp-accent));background:radial-gradient(120% 95% at 100% 0%,color-mix(in oklab,var(--yp-h) 58%,var(--yp-ground)) 0%,transparent 72%),linear-gradient(170deg,color-mix(in oklab,var(--yp-h) 40%,var(--yp-ground)) 0%,color-mix(in oklab,var(--yp-h) 14%,var(--yp-ground)) 100%)}
[data-ui-stage] .yp-tile::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.6}
[data-ui-stage] .yp-pat-0::before{background:radial-gradient(color-mix(in srgb,var(--yp-text) 26%,transparent) .9px,transparent 1.4px) 0 0/10px 10px;-webkit-mask-image:linear-gradient(205deg,#000 10%,transparent 70%);mask-image:linear-gradient(205deg,#000 10%,transparent 70%)}
[data-ui-stage] .yp-pat-1::before{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--yp-text) 15%,transparent) 0 1px,transparent 1px 7px);-webkit-mask-image:linear-gradient(25deg,transparent 35%,#000 95%);mask-image:linear-gradient(25deg,transparent 35%,#000 95%)}
[data-ui-stage] .yp-pat-2::before{background:repeating-radial-gradient(circle at 100% 0%,transparent 0 11px,color-mix(in srgb,var(--yp-text) 18%,transparent) 11px 12px);-webkit-mask-image:radial-gradient(circle at 100% 0%,#000 20%,transparent 75%);mask-image:radial-gradient(circle at 100% 0%,#000 20%,transparent 75%)}
[data-ui-stage] .yp-pat-3::before{opacity:.5;background:radial-gradient(55% 60% at 12% 100%,color-mix(in oklab,var(--yp-h) 55%,var(--yp-text)) 0%,transparent 70%),radial-gradient(40% 45% at 92% 18%,color-mix(in oklab,var(--yp-h) 70%,var(--yp-ground)) 0%,transparent 70%)}
[data-ui-stage] .yp-glyph{position:absolute;left:14px;top:12px;font-size:56px;line-height:1;font-weight:700;letter-spacing:0;color:color-mix(in oklab,var(--yp-text) 86%,var(--yp-h));opacity:.9;pointer-events:none;white-space:nowrap}
[data-ui-stage] .yp-body{display:flex;flex-direction:column;gap:3px;padding:11px 13px 13px;min-width:0;flex:none}
[data-ui-stage] .yp-title{font-size:15px;font-weight:650;line-height:1.3;letter-spacing:.01em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
[data-ui-stage] .yp-sub{font-size:12.5px;line-height:1.45;color:var(--yp-muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
[data-ui-stage] .yp-detail{font-size:13px;line-height:1.65;color:color-mix(in srgb,var(--yp-text) 82%,transparent);white-space:pre-wrap;margin-top:4px;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
[data-ui-stage] .yp-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
[data-ui-stage] .yp-tag{font-size:10.5px;line-height:1;padding:4px 7px;border-radius:999px;background:color-mix(in srgb,var(--yp-accent) 16%,transparent);color:color-mix(in srgb,var(--yp-accent) 60%,var(--yp-text))}
[data-ui-stage] .yp-check{position:absolute;top:8px;right:8px;z-index:2;width:22px;height:22px;border-radius:999px;display:flex;align-items:center;justify-content:center;background:var(--yp-accent);color:var(--yp-on-accent);font-size:12px;font-weight:800;box-shadow:0 2px 8px rgba(0,0,0,.28);transform:scale(0);transition:transform .22s cubic-bezier(.3,1.6,.5,1)}
[data-ui-stage] [aria-pressed="true"]>.yp-check{transform:scale(1)}
[data-ui-stage] .yp-row{flex-direction:row}
[data-ui-stage] .yp-row>.yp-media{width:76px;min-height:76px;flex:none;align-self:stretch}
[data-ui-stage] .yp-row .yp-glyph,[data-ui-stage] .yp-thumb .yp-glyph{left:50%;top:50%;transform:translate(-50%,-50%);font-size:30px}
[data-ui-stage] .yp-row>.yp-body{flex:1;justify-content:center;padding:10px 38px 10px 13px}
[data-ui-stage] .yp-row>.yp-check{top:50%;margin-top:-11px;right:12px}
[data-ui-stage] .yp-hero{height:100%;width:100%;justify-content:flex-end}
[data-ui-stage] .yp-hero>.yp-media{position:absolute;inset:0;height:auto}
[data-ui-stage] .yp-hero>.yp-media::after{content:"";position:absolute;left:0;right:0;bottom:0;height:70%;background:linear-gradient(180deg,transparent,rgba(8,8,12,.84));pointer-events:none}
[data-ui-stage] .yp-hero .yp-glyph{font-size:168px;left:auto;right:-.06em;top:.02em;opacity:.8}
[data-ui-stage] .yp-hero>.yp-body{position:relative;z-index:1;padding:20px 20px 22px;gap:6px;color:#fff}
[data-ui-stage] .yp-hero .yp-title{font-size:22px;font-weight:700}
[data-ui-stage] .yp-hero .yp-sub{font-size:13.5px;color:rgba(255,255,255,.8)}
[data-ui-stage] .yp-hero .yp-detail{color:rgba(255,255,255,.9);-webkit-line-clamp:5}
[data-ui-stage] .yp-hero .yp-tag{background:rgba(255,255,255,.16);color:#fff}
[data-ui-stage] .yp-car{position:relative;flex:1;min-height:0;overflow:hidden;border-radius:var(--yp-radius);touch-action:pan-y;outline:none}
[data-ui-stage] .yp-car:focus-visible{box-shadow:0 0 0 2px var(--yp-accent)}
[data-ui-stage] .yp-track{display:flex;height:100%;transition:transform .42s cubic-bezier(.2,.8,.2,1)}
[data-ui-stage] .yp-slide{flex:0 0 100%;height:100%;padding:0 1px}
[data-ui-stage] .yp-nav{position:absolute;top:42%;z-index:3;width:36px;height:36px;margin-top:-18px;border-radius:999px;border:1px solid rgba(255,255,255,.22);background:rgba(10,10,14,.42);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#fff;font-size:20px;line-height:1;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0 0 2px;transition:background .15s ease,opacity .2s ease}
[data-ui-stage] .yp-nav:hover{background:rgba(10,10,14,.64)}
[data-ui-stage] .yp-nav:disabled{opacity:0;pointer-events:none}
[data-ui-stage] .yp-prev{left:10px}
[data-ui-stage] .yp-next{right:10px}
[data-ui-stage] .yp-dots{display:flex;justify-content:center;align-items:center;gap:6px;flex:none;height:10px}
[data-ui-stage] .yp-dot{width:7px;height:7px;padding:0;border:0;border-radius:999px;background:var(--yp-line);cursor:pointer;transition:width .25s ease,background .25s ease}
[data-ui-stage] .yp-dot[aria-current="true"]{width:20px;background:var(--yp-accent)}
[data-ui-stage] .yp-chips{display:flex;gap:6px;flex:none;overflow-x:auto;scrollbar-width:none;padding:1px}
[data-ui-stage] .yp-chips::-webkit-scrollbar{display:none}
[data-ui-stage] .yp-chip{flex:none;border:1px solid var(--yp-line);background:transparent;color:var(--yp-muted);border-radius:999px;padding:5px 11px;font-size:12px;line-height:1.25;cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease,transform .12s ease}
[data-ui-stage] .yp-chip:hover{color:var(--yp-text);border-color:color-mix(in srgb,var(--yp-accent) 55%,var(--yp-line))}
[data-ui-stage] .yp-chip:active{transform:scale(.96)}
[data-ui-stage] .yp-chip[aria-pressed="true"],[data-ui-stage] .yp-chip[aria-checked="true"]{background:var(--yp-accent);color:var(--yp-on-accent);border-color:transparent;box-shadow:0 6px 16px -10px var(--yp-accent)}
[data-ui-stage] .yp-confirm{flex:none;min-height:44px;padding:0 18px;border:0;border-radius:var(--yc-send-radius,var(--yp-radius));background:var(--yp-accent);color:var(--yp-on-accent);font-size:15px;font-weight:650;letter-spacing:.03em;cursor:pointer;box-shadow:0 10px 22px -14px var(--yp-accent);transition:transform .15s ease,filter .15s ease,opacity .2s ease}
[data-ui-stage] .yp-confirm:hover:not(:disabled){filter:brightness(1.07);transform:translateY(-1px)}
[data-ui-stage] .yp-confirm:active:not(:disabled){transform:scale(.98)}
[data-ui-stage] .yp-confirm:disabled{opacity:.38;cursor:default;box-shadow:none}
[data-ui-stage] .yp-field{display:flex;flex-direction:column;gap:8px}
[data-ui-stage] .yp-label{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:13px;font-weight:600;line-height:1.35;letter-spacing:.02em;color:var(--yp-text)}
[data-ui-stage] .yp-label output{font-weight:700;color:var(--yp-accent);font-variant-numeric:tabular-nums}
[data-ui-stage] .yp-input{width:100%;min-height:44px;padding:10px 14px;border-radius:var(--yp-radius);border:1px solid var(--yp-line);background:var(--yp-card);color:var(--yc-input-fg,var(--yp-text));font-size:15px;line-height:1.4;outline:none;box-shadow:inset 0 1px 2px rgba(0,0,0,.08);transition:border-color .15s ease,box-shadow .15s ease,background .15s ease;-moz-appearance:textfield}
[data-ui-stage] .yp-input::placeholder{color:var(--yp-muted);opacity:.8}
[data-ui-stage] .yp-input:hover{border-color:color-mix(in srgb,var(--yp-text) 26%,transparent)}
[data-ui-stage] .yp-input:focus{border-color:var(--yp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--yp-accent) 22%,transparent)}
[data-ui-stage] .yp-input::-webkit-inner-spin-button,[data-ui-stage] .yp-input::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
[data-ui-stage] textarea.yp-input{flex:1;min-height:64px;resize:none;line-height:1.65}
[data-ui-stage] .yp-num{display:flex;gap:6px}
[data-ui-stage] .yp-num .yp-input{text-align:center;font-variant-numeric:tabular-nums}
[data-ui-stage] .yp-step{flex:none;width:44px;border-radius:var(--yp-radius);border:1px solid var(--yp-line);background:var(--yp-card);color:var(--yp-text);font-size:18px;line-height:1;cursor:pointer;transition:border-color .15s ease,transform .12s ease}
[data-ui-stage] .yp-step:hover{border-color:var(--yp-accent)}
[data-ui-stage] .yp-step:active{transform:scale(.95)}
[data-ui-stage] .yp-range{-webkit-appearance:none;appearance:none;width:100%;height:28px;margin:0;background:transparent;cursor:pointer;--yp-fill:50%}
[data-ui-stage] .yp-range:focus{outline:none}
[data-ui-stage] .yp-range::-webkit-slider-runnable-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--yp-accent) var(--yp-fill),var(--yp-line) var(--yp-fill))}
[data-ui-stage] .yp-range::-moz-range-track{height:6px;border-radius:999px;background:linear-gradient(90deg,var(--yp-accent) var(--yp-fill),var(--yp-line) var(--yp-fill))}
[data-ui-stage] .yp-range::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;margin-top:-7px;border-radius:999px;background:#fff;border:3px solid var(--yp-accent);box-shadow:0 2px 6px rgba(0,0,0,.3);transition:transform .12s ease}
[data-ui-stage] .yp-range::-moz-range-thumb{width:14px;height:14px;border-radius:999px;background:#fff;border:3px solid var(--yp-accent);box-shadow:0 2px 6px rgba(0,0,0,.3)}
[data-ui-stage] .yp-range:active::-webkit-slider-thumb{transform:scale(1.15)}
[data-ui-stage] .yp-range:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px color-mix(in srgb,var(--yp-accent) 30%,transparent)}
[data-ui-stage] .yp-chipset{display:flex;flex-wrap:wrap;gap:8px}
[data-ui-stage] .yp-chipset .yp-chip{font-size:13.5px;padding:8px 15px;color:var(--yp-text);background:var(--yp-card)}
[data-ui-stage] .yp-chip-custom{border-style:dashed}
[data-ui-stage] .yp-chipset .yp-chip.yp-chip-custom:not([aria-checked="true"]){background:transparent;color:var(--yp-muted)}
[data-ui-stage] input.yp-chip{width:140px;outline:none;cursor:text;border-color:var(--yp-accent);border-style:solid}
[data-ui-stage] .yp-scrim{position:absolute;inset:0;background:rgba(6,8,12,.56);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);animation:ypFade .22s ease both;pointer-events:auto}
[data-ui-stage] .yp-pop{display:flex;flex-direction:column;border-radius:calc(var(--yp-radius) + 6px);background:var(--yp-card-solid);border:1px solid var(--yp-line);box-shadow:0 30px 70px -24px rgba(0,0,0,.7),inset 0 1px 0 color-mix(in srgb,var(--yp-text) 8%,transparent);overflow:hidden;animation:ypRise .36s cubic-bezier(.2,.9,.25,1.1) both}
[data-ui-stage] .yp-pop-media{position:relative;flex:0 1 46%;min-height:0;overflow:hidden}
[data-ui-stage] .yp-pop-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:22px 22px 10px}
[data-ui-stage] .yp-pop-title{font-size:19px;font-weight:700;line-height:1.3;letter-spacing:.01em;padding-right:26px}
[data-ui-stage] .yp-pop-text{font-size:14.5px;line-height:1.75;white-space:pre-wrap;color:color-mix(in srgb,var(--yp-text) 84%,transparent)}
[data-ui-stage] .yp-pop>.yp-confirm{margin:6px 18px 18px}
[data-ui-stage] .yp-x{position:absolute;top:12px;right:12px;z-index:3;width:30px;height:30px;padding:0 0 2px;border:0;border-radius:999px;background:color-mix(in srgb,var(--yp-text) 8%,transparent);color:var(--yp-muted);font-size:18px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s ease,color .15s ease}
[data-ui-stage] .yp-x:hover{background:color-mix(in srgb,var(--yp-text) 16%,transparent);color:var(--yp-text)}
[data-ui-stage] .yp-list{display:flex;flex-direction:column;overflow:auto;scrollbar-width:thin;scrollbar-color:var(--yp-line) transparent}
[data-ui-stage] .yp-list.yp-across{flex-direction:row;overflow-x:auto;overflow-y:hidden}
[data-ui-stage] .yp-list.yp-across>.yp-card{flex:0 0 150px}
[data-ui-stage] .yp-list.yp-grid{display:grid;align-content:start;grid-auto-rows:max-content}
[data-ui-stage] .yp-list>.yp-card{flex:none;min-height:min-content}
[data-ui-stage] .yp-list .yp-media{flex:none}
[data-ui-stage] .yp-empty{flex:1 0 auto;grid-column:1/-1;min-height:100%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;text-align:center;text-wrap:balance;font-size:14px;line-height:1.6;color:var(--yp-muted);padding:24px 20px}
[data-ui-stage] .yp-badge{position:absolute;top:8px;right:8px;z-index:2;font-size:10.5px;font-weight:700;line-height:1;padding:4px 8px;border-radius:999px;background:var(--yp-accent);color:var(--yp-on-accent);box-shadow:0 2px 8px rgba(0,0,0,.2)}
[data-ui-stage] .yp-row>.yp-badge{position:static;align-self:center;margin-right:12px;flex:none}
[data-ui-stage] .yp-row.yp-thumb>.yp-media{width:60px;min-height:60px}
[data-ui-stage] .yp-list .yp-row>.yp-body{padding-right:13px}
[data-ui-stage] .yp-list:not(.yp-across) .yp-card:not([data-locked]) .yp-sub{-webkit-line-clamp:3}
[data-ui-stage] .yp-list.yp-across .yp-title,[data-ui-stage] .yp-list.yp-across .yp-sub{-webkit-line-clamp:1}
[data-ui-stage] .yp-card[data-locked] .yp-media img{filter:grayscale(1) blur(5px) brightness(.55)}
[data-ui-stage] .yp-card[data-locked] .yp-media{background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--yp-text) 6%,transparent) 0 1px,transparent 1px 7px),color-mix(in srgb,var(--yp-text) 4%,var(--yp-ground))}
[data-ui-stage] .yp-card[data-locked]{background:color-mix(in srgb,var(--yp-card) 55%,transparent);border-style:dashed;box-shadow:none}
[data-ui-stage] .yp-card[data-locked] .yp-title{color:var(--yp-muted);letter-spacing:.14em}
[data-ui-stage] .yp-lock{position:absolute;inset:0;z-index:1;display:flex;align-items:center;justify-content:center;color:var(--yp-muted)}
[data-ui-stage] .yp-rowbtn{display:block;width:100%;text-align:left;border:0;cursor:pointer;font:inherit}
@media (prefers-reduced-motion:reduce){[data-ui-stage] .yp,[data-ui-stage] .yp *,[data-ui-stage]:has(.yp-scrim)::after{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`.trim();

/**
 * The helper components. Plain JS inside TSX, no bare hooks (the body runs in
 * `new Function(React, …)`), and every step a creator wrote is still a real
 * compiled function handed in as a prop.
 */
export const PARTS_RUNTIME = String.raw`
/** A token of a scope, resolved BEFORE the ordinary {{var}} pass:
 *  {{choice}} is the picked option's value, {{value.field}} walks into a
 *  popup's variable. Missing fields become "". */
function bindText(template, name, value) {
  const re = new RegExp("\\{\\{\\s*" + name + "((?:\\.[\\w$]+)*)\\s*\\}\\}", "g");
  return String(template || "").replace(re, function (_m, path) {
    let v = value;
    if (path) {
      const segs = path.slice(1).split(".");
      for (let i = 0; i < segs.length; i++) {
        if (v === null || v === undefined) break;
        v = v[segs[i]];
      }
    }
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.join(", ");
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** Run a creator's compiled steps; a step that throws stops its own list and
 *  nothing else. */
function runSteps(fn, args) {
  if (typeof fn !== "function") return Promise.resolve();
  return Promise.resolve()
    .then(function () { return fn.apply(null, args); })
    .catch(function (err) { if (typeof console !== "undefined") console.warn("[card] action failed", err); });
}

/** First letter of a title, for a card with no picture yet. */
function monogram(title) {
  const text = String(title || "").trim();
  if (!text) return "✦";
  return Array.from(text)[0].toUpperCase();
}

/**
 * A card with no picture gets a tile of its own rather than the same
 * placeholder as its neighbours: a hue, a pattern and its first letter, all
 * picked off the card's id and title — so the tile is stable across edits and
 * reloads, and four cards never come out as four copies. Hues are muted and
 * mixed toward the theme's accent and ground, so a 素纸 card gets paper tints
 * and a 夜航 card gets night ones. Neighbours step off a hue already taken.
 */
const TILE_HUES = ["#c8734d", "#4f7fc4", "#8a62c4", "#3f9a82", "#c29a3f", "#c45a82", "#6f8f3f", "#5b6bc4"];

function hashText(text) {
  let h = 2166136261;
  const str = String(text || "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tilesFor(keys) {
  const used = [];
  return keys.map(function (key) {
    const h = hashText(key);
    let hue = h % TILE_HUES.length;
    for (let tries = 0; tries < TILE_HUES.length && used.indexOf(hue) >= 0; tries++) hue = (hue + 3) % TILE_HUES.length;
    used.push(hue);
    if (used.length >= TILE_HUES.length) used.length = 0;
    return { hue: TILE_HUES[hue], pat: (h >>> 5) % 4 };
  });
}

function Tile({ tile, title, style, children }) {
  const t = tile || { hue: TILE_HUES[0], pat: 0 };
  return (
    <span className={"yp-media yp-tile yp-pat-" + t.pat} style={Object.assign({ "--yp-hue": t.hue }, style || null)}>
      {title !== null ? <span className="yp-glyph" aria-hidden="true">{monogram(title)}</span> : null}
      {children}
    </span>
  );
}

function choiceValue(o) {
  return o.value !== undefined && o.value !== null && o.value !== "" ? String(o.value) : String(o.title || "");
}

function pickedFrom(stored, multi) {
  if (multi) return Array.isArray(stored) ? stored.map(String) : filled(stored) ? [String(stored)] : [];
  if (Array.isArray(stored)) return stored.length ? [String(stored[0])] : [];
  return filled(stored) ? [String(stored)] : [];
}

/** Whether a card should play its entrance. Never in the editor, which
 *  remounts the card on every keystroke — a stagger there is a flicker. */
function partsEnter() {
  return !editorGhosts();
}

function ChoiceCard({ o, i, variant, picked, full, busy, onPick, cardStyle, selectedStyle, titleStyle, subStyle, ratio, enter, role, tile }) {
  const showMedia = ratio !== 0;
  const mediaStyle = variant === "grid" ? { aspectRatio: "1 / " + (ratio > 0 ? ratio : 0.72) } : undefined;
  const style = Object.assign({}, cardStyle || null, picked ? selectedStyle || null : null, enter ? { animationDelay: Math.min(i, 12) * 45 + "ms" } : null);
  return (
    <button
      type="button"
      role={role}
      className={"yp-card" + (variant === "row" ? " yp-row" : variant === "hero" ? " yp-hero" : "") + (enter ? " yp-enter" : "")}
      aria-pressed={picked}
      aria-disabled={full || busy ? true : undefined}
      onClick={onPick}
      style={style}
    >
      <span className="yp-check" aria-hidden="true">✓</span>
      {showMedia ? (
        o.image ? (
          <span className="yp-media" style={mediaStyle}>
            <span style={{ position: "absolute", inset: 0 }}><Img src={o.image} fit="cover" /></span>
          </span>
        ) : <Tile tile={tile} title={o.title} style={mediaStyle} />
      ) : null}
      <span className="yp-body">
        <span className="yp-title" style={titleStyle}>{o.title}</span>
        {o.subtitle ? <span className="yp-sub" style={subStyle}>{o.subtitle}</span> : null}
        {o.detail && variant !== "grid" ? <span className="yp-detail">{o.detail}</span> : null}
        {o.tags && o.tags.length ? (
          <span className="yp-tags">{o.tags.map(function (tag) { return <span key={tag} className="yp-tag">{tag}</span>; })}</span>
        ) : null}
      </span>
    </button>
  );
}

function UiChoice(props) {
  const api = props.api, vars = props.vars, options = props.options || [], multi = !!props.multi;
  const variableId = props.variableId || "";
  const stored = variableId ? readVar(vars, variableId) : undefined;
  const storedKey = JSON.stringify(stored === undefined ? null : stored);
  const [local, setLocal] = React.useState(null);
  React.useEffect(function () { setLocal(null); }, [storedKey]);
  const [tag, setTag] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [at, setAt] = React.useState(0);
  const swipe = React.useRef(null);
  const picked = local !== null ? local : pickedFrom(stored, multi);
  const cap = multi ? (props.maxPick > 0 ? props.maxPick : Infinity) : 1;
  const tags = [];
  options.forEach(function (o) { (o.tags || []).forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); }); });
  const shown = tag ? options.filter(function (o) { return (o.tags || []).indexOf(tag) >= 0; }) : options;
  const index = Math.max(0, Math.min(at, shown.length - 1));
  const enter = partsEnter();
  // Tiles are dealt over ALL options, so filtering by tag never recolours one.
  const tiles = tilesFor(options.map(function (o) { return o.id + "|" + (o.title || ""); }));
  const tileOf = function (o) { return tiles[options.indexOf(o)]; };

  function write(next) {
    setLocal(next);
    if (variableId && api.setVariable) api.setVariable(variableId, multi ? next : next.length ? next[0] : "");
  }
  function run(list, withConfirm) {
    if (busy) return;
    setBusy(true);
    const copy = Object.assign({}, vars);
    const values = list.map(choiceValue);
    if (variableId) copy[variableId] = multi ? values : values[0];
    (async function () {
      for (let i = 0; i < list.length; i++) await runSteps(list[i].run, [copy, values[i]]);
      if (withConfirm && props.confirm) await runSteps(props.confirm.run, [copy, values.join(", ")]);
      // Switching the opening restores that opening's variables, which
      // would throw the pick away — so it is written again once the steps
      // are done.
      const switched = list.some(function (o) { return o.sw; }) || (withConfirm && props.confirm && props.confirm.sw);
      if (switched && variableId && api.setVariable) api.setVariable(variableId, multi ? values : values[0]);
    })().finally(function () { setBusy(false); });
  }
  function pick(o) {
    if (busy) return;
    const v = choiceValue(o);
    const has = picked.indexOf(v) >= 0;
    if (multi) {
      if (!has && picked.length >= cap) return;
      write(has ? picked.filter(function (x) { return x !== v; }) : picked.concat([v]));
      return;
    }
    write([v]);
    if (!props.confirm) run([o], false);
  }
  function confirm() {
    const list = options.filter(function (o) { return picked.indexOf(choiceValue(o)) >= 0; });
    if (list.length === 0) return;
    run(list, true);
  }
  function go(to) {
    if (!shown.length) return;
    setAt(Math.max(0, Math.min(shown.length - 1, to)));
  }

  const card = function (o, i, variant) {
    const isPicked = picked.indexOf(choiceValue(o)) >= 0;
    return (
      <ChoiceCard
        key={o.id}
        o={o}
        i={i}
        variant={variant}
        picked={isPicked}
        full={multi && !isPicked && picked.length >= cap}
        busy={busy}
        enter={enter && variant !== "hero"}
        ratio={props.imageRatio}
        tile={tileOf(o)}
        cardStyle={props.cardStyle}
        selectedStyle={props.selectedStyle}
        titleStyle={props.titleStyle}
        subStyle={props.subStyle}
        onPick={function () {
          if (variant === "hero" && swipe.current && swipe.current.moved) return;
          pick(o);
        }}
      />
    );
  };

  let body;
  if (props.layout === "carousel") {
    body = (
      <React.Fragment>
        <div
          className="yp-car"
          tabIndex={0}
          role="region"
          aria-roledescription="carousel"
          onKeyDown={function (e) {
            if (e.key === "ArrowLeft") { e.preventDefault(); go(index - 1); }
            if (e.key === "ArrowRight") { e.preventDefault(); go(index + 1); }
          }}
          onPointerDown={function (e) { swipe.current = { x: e.clientX, y: e.clientY, moved: false }; }}
          onPointerUp={function (e) {
            const s = swipe.current;
            if (!s) return;
            const dx = e.clientX - s.x;
            if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(e.clientY - s.y)) {
              s.moved = true;
              go(index + (dx < 0 ? 1 : -1));
            }
          }}
        >
          <div className="yp-track" style={{ transform: "translateX(" + (-index * 100) + "%)" }}>
            {shown.map(function (o, i) {
              return <div key={o.id} className="yp-slide" aria-hidden={i !== index} aria-roledescription="slide">{card(o, i, "hero")}</div>;
            })}
          </div>
          <button type="button" className="yp-nav yp-prev" aria-label="Previous" disabled={index <= 0} onClick={function () { go(index - 1); }}>‹</button>
          <button type="button" className="yp-nav yp-next" aria-label="Next" disabled={index >= shown.length - 1} onClick={function () { go(index + 1); }}>›</button>
        </div>
        {shown.length > 1 ? (
          <div className="yp-dots">
            {shown.map(function (o, i) {
              return <button key={o.id} type="button" className="yp-dot" aria-label={String(i + 1)} aria-current={i === index} onClick={function () { go(i); }} />;
            })}
          </div>
        ) : null}
      </React.Fragment>
    );
  } else {
    const grid = props.layout !== "list";
    // A count the creator set is the count, on the phone and the wide canvas
    // alike — "3 per row" that still drew 4 on a desktop read as a setting
    // that did nothing. Left unset (0), the phone gets two and the wide
    // canvas fits as many ~170px cards as the box holds, never more than
    // there are: the phone's two there would be the size of posters.
    const set = props.columns > 0 ? props.columns : 0;
    const width = props.frame && typeof props.frame.width === "number" ? props.frame.width : 0;
    const cols = set ? set
      : !grid ? 1
      : props.wide && width ? Math.max(2, Math.min(shown.length, Math.floor(width / 170)))
      : 2;
    body = (
      <div className="yp-scroll">
        <div
          className={grid ? "yp-grid" : "yp-stack"}
          style={grid ? { gridTemplateColumns: "repeat(" + cols + ", minmax(0, 1fr))", gap: props.gap } : { gap: props.gap }}
        >
          {shown.map(function (o, i) { return card(o, i, grid ? "grid" : "row"); })}
        </div>
      </div>
    );
  }

  return (
    <div data-ui-el={props.elId} className="yp yp-choice" style={props.frame} role={multi ? "group" : undefined}>
      {props.tagFilter && tags.length > 0 ? (
        <div className="yp-chips">
          {tags.map(function (t) {
            return <button key={t} type="button" className="yp-chip" aria-pressed={tag === t} onClick={function () { setTag(tag === t ? null : t); setAt(0); }}>{t}</button>;
          })}
        </div>
      ) : null}
      {body}
      {props.confirm ? (
        <button type="button" className="yp-confirm" disabled={busy || picked.length === 0} onClick={confirm} style={props.confirm.style}>
          {props.confirm.label}
        </button>
      ) : null}
    </div>
  );
}

function clampNum(value, min, max) {
  let v = value;
  if (typeof min === "number" && Number.isFinite(min)) v = Math.max(min, v);
  if (typeof max === "number" && Number.isFinite(max)) v = Math.min(max, v);
  return v;
}

function UiField(props) {
  const api = props.api, vars = props.vars, kind = props.kind, variableId = props.variableId;
  const numeric = kind === "number" || kind === "slider";
  const stored = readVar(vars, variableId);
  const shown = stored === undefined || stored === null ? "" : typeof stored === "object" ? JSON.stringify(stored) : String(stored);
  const [draft, setDraft] = React.useState(shown);
  const [custom, setCustom] = React.useState(null);
  const focused = React.useRef(false);
  const timer = React.useRef(null);
  const latest = React.useRef(shown);
  React.useEffect(function () { if (!focused.current) { setDraft(shown); latest.current = shown; } }, [shown]);
  function commit(raw) {
    if (!api.setVariable) return;
    if (numeric) {
      const v = Number(raw);
      if (raw === "" || !Number.isFinite(v)) return;
      api.setVariable(variableId, clampNum(v, props.min, props.max));
      return;
    }
    api.setVariable(variableId, raw);
  }
  React.useEffect(function () {
    return function () {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; commit(latest.current); }
    };
  }, []);
  function type(raw, delay) {
    const before = latest.current;
    setDraft(raw);
    latest.current = raw;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    // The first character lands at once: a "开始" button waiting on this
    // field wakes up as soon as there is something in it, not 300ms later.
    if (!delay || filled(before) !== filled(raw)) { commit(raw); return; }
    timer.current = setTimeout(function () { timer.current = null; commit(raw); }, delay);
  }
  function flush() {
    focused.current = false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; commit(latest.current); }
  }
  const fid = "yp-f-" + props.elId;
  const label = props.label ? (
    <label id={fid + "-l"} htmlFor={kind === "chips" ? undefined : fid} className="yp-label" style={props.labelStyle}>
      <span>{props.label}</span>
      {kind === "slider" ? <output htmlFor={fid}>{draft === "" ? String(props.min !== undefined ? props.min : 0) : draft}</output> : null}
    </label>
  ) : null;
  const inputProps = {
    id: fid,
    className: "yp-input",
    style: props.inputStyle,
    placeholder: props.placeholder || undefined,
    value: draft,
    "aria-labelledby": props.label ? fid + "-l" : undefined,
    onFocus: function () { focused.current = true; },
    onBlur: flush,
  };
  let control;
  if (kind === "textarea") {
    control = <textarea {...inputProps} onChange={function (e) { type(e.target.value, 300); }} />;
  } else if (kind === "number") {
    const step = props.step > 0 ? props.step : 1;
    const bump = function (dir) {
      const base = Number(latest.current);
      const start = Number.isFinite(base) && latest.current !== "" ? base : typeof props.min === "number" ? props.min : 0;
      type(String(clampNum(Math.round((start + dir * step) * 1e6) / 1e6, props.min, props.max)), 0);
    };
    control = (
      <div className="yp-num">
        <button type="button" className="yp-step" aria-label="-" onClick={function () { bump(-1); }}>−</button>
        <input {...inputProps} type="number" inputMode="decimal" min={props.min} max={props.max} step={step} onChange={function (e) { type(e.target.value, 300); }} onKeyDown={function (e) { if (e.key === "Enter") flush(); }} />
        <button type="button" className="yp-step" aria-label="+" onClick={function () { bump(1); }}>+</button>
      </div>
    );
  } else if (kind === "slider") {
    const min = typeof props.min === "number" ? props.min : 0;
    const max = typeof props.max === "number" ? props.max : 100;
    const now = draft === "" || !Number.isFinite(Number(draft)) ? min : Number(draft);
    const fill = max > min ? Math.max(0, Math.min(100, ((now - min) / (max - min)) * 100)) : 0;
    control = (
      <input
        id={fid}
        type="range"
        className="yp-range"
        min={min}
        max={max}
        step={props.step > 0 ? props.step : 1}
        value={now}
        aria-labelledby={props.label ? fid + "-l" : undefined}
        style={Object.assign({ "--yp-fill": fill + "%" }, props.inputStyle || null)}
        onFocus={function () { focused.current = true; }}
        onBlur={flush}
        onChange={function (e) { type(e.target.value, 150); }}
      />
    );
  } else if (kind === "chips") {
    const options = props.options || [];
    const isCustom = shown !== "" && options.indexOf(shown) < 0;
    control = (
      <div className="yp-chipset" role="radiogroup" aria-labelledby={props.label ? fid + "-l" : undefined}>
        {options.map(function (o) {
          const on = shown === o;
          return (
            <button key={o} type="button" role="radio" aria-checked={on} className="yp-chip" style={Object.assign({}, props.chipStyle || null, on ? props.chipOnStyle || null : null)} onClick={function () { type(on ? "" : o, 0); }}>
              {o}
            </button>
          );
        })}
        {props.allowCustom ? (
          custom !== null ? (
            <input
              autoFocus
              className="yp-chip"
              value={custom}
              placeholder={props.placeholder || ""}
              aria-label={props.placeholder || props.label || "custom"}
              onChange={function (e) { setCustom(e.target.value); }}
              onBlur={function () { if (custom.trim()) type(custom.trim(), 0); setCustom(null); }}
              onKeyDown={function (e) {
                if (e.key === "Enter") { if (custom.trim()) type(custom.trim(), 0); setCustom(null); }
                if (e.key === "Escape") setCustom(null);
              }}
            />
          ) : (
            <button type="button" role="radio" aria-checked={isCustom} className="yp-chip yp-chip-custom" style={Object.assign({}, props.chipStyle || null, isCustom ? props.chipOnStyle || null : null)} onClick={function () { setCustom(isCustom ? shown : ""); }}>
              {isCustom ? shown : "＋ " + (props.placeholder || "…")}
            </button>
          )
        ) : null}
      </div>
    );
  } else {
    control = <input {...inputProps} type="text" onChange={function (e) { type(e.target.value, 300); }} onKeyDown={function (e) { if (e.key === "Enter") flush(); }} />;
  }
  return (
    <div data-ui-el={props.elId} className="yp yp-field" style={props.frame}>
      {label}
      {control}
    </div>
  );
}

/** What "cleared" means for the value a popup was showing. */
function emptyLike(value) {
  if (Array.isArray(value)) return [];
  if (typeof value === "boolean") return false;
  if (typeof value === "number") return 0;
  if (value && typeof value === "object") return {};
  return "";
}

/** The card is as tall as what it says, up to the box it was given — a two-line
 *  clue should not sit in a card built for a letter. */
function popFit(frame) {
  if (!frame || typeof frame.height !== "number") return null;
  return { height: "auto", maxHeight: frame.height, minHeight: Math.min(frame.height, 150) };
}

function popupShown(value) {
  return filled(value) && value !== 0;
}

function UiPopup(props) {
  const api = props.api, vars = props.vars;
  const value = readVar(vars, props.variableId);
  const key = JSON.stringify(value === undefined ? null : value);
  const [closed, setClosed] = React.useState(null);
  const live = popupShown(value) && closed !== key;
  function close() {
    setClosed(key);
    if (props.clearOnClose && api.setVariable) api.setVariable(props.variableId, emptyLike(value));
  }
  React.useEffect(function () {
    if (!live || typeof window === "undefined") return undefined;
    const onKey = function (e) { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return function () { window.removeEventListener("keydown", onKey); };
  }, [live, key]);
  // In the editor an empty popup still shows its card (no dim layer), or it
  // could never be clicked to edit. A played card shows it only when there
  // is something to say.
  if (!live && !editorGhosts()) return null;
  // An empty popup in the editor stands in "……" for what the variable will
  // say, so the card is laid out around text rather than around a hole.
  const text = function (template) {
    if (!live) return interpolate(vars, String(template || "").replace(/\{\{\s*value(?:\.[\w$]+)*\s*\}\}/g, "……"));
    return interpolate(vars, bindText(template, "value", value));
  };
  const title = text(props.title);
  const button = text(props.buttonLabel);
  const z = props.z;
  return (
    <React.Fragment>
      {live ? <div className="yp yp-scrim" style={{ zIndex: z, background: props.scrim || undefined }} onClick={close} /> : null}
      <div data-ui-el={props.elId} className="yp yp-pop" role="dialog" aria-modal={live ? true : undefined} aria-label={title || undefined} style={Object.assign({}, props.frame, popFit(props.frame), { zIndex: z + 1 }, props.cardStyle || null)}>
        <button type="button" className="yp-x" aria-label="Close" onClick={close}>×</button>
        {props.image ? <div className="yp-pop-media"><Img src={props.image} fit="cover" /></div> : null}
        <div className="yp-pop-body">
          {title ? <div className="yp-pop-title" style={props.titleStyle}>{title}</div> : null}
          <div className="yp-pop-text" style={props.bodyStyle}>{text(props.body)}</div>
        </div>
        {button ? <button type="button" className="yp-confirm" style={props.buttonStyle} onClick={close}>{button}</button> : null}
      </div>
    </React.Fragment>
  );
}

/** Whether a collection variable admits this row: an array of ids holding it,
 *  an object with it set, or a comma list naming it. */
function unlocked(bag, id) {
  if (id === undefined || id === null || id === "") return false;
  if (Array.isArray(bag)) return contains(bag, id);
  if (bag && typeof bag === "object") return !!bag[id];
  if (typeof bag === "string") return bag.split(/[,，、\s]+/).indexOf(String(id)) >= 0;
  return false;
}

function rowField(item, field) {
  if (!field || item === null || typeof item !== "object") return field ? undefined : item;
  return item[field];
}

const LOCK_ICON = (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </svg>
);

function UiCardList(props) {
  const api = props.api, vars = props.vars, rows = props.rows || [], card = props.card || {};
  const enter = partsEnter();
  const ratio = card.imageRatio;
  const vertical = typeof ratio === "number" && ratio > 0;
  const across = props.direction === "row";
  const cols = across && props.columns > 0 ? props.columns : 0;
  const cls = "yp yp-list" + (cols ? " yp-grid" : across ? " yp-across" : "");
  const style = Object.assign({}, props.frame, { gap: props.gap }, cols ? { gridTemplateColumns: "repeat(" + cols + ", minmax(0, 1fr))" } : null);
  const tiles = tilesFor(rows.map(function (item, i) {
    return item && typeof item === "object" ? (item.id || item.name || item.title || i) + "|" + i : String(item) + "|" + i;
  }));
  return (
    <div data-ui-el={props.elId} className={cls} style={style}>
      {rows.length === 0 && props.empty ? <div className="yp-empty">{props.empty}</div> : null}
      {rows.map(function (item, i) {
        const locked = props.lockVar ? !unlocked(readVar(vars, props.lockVar), rowField(item, props.lockField)) : false;
        const t = function (template) { return template ? interpolate(vars, itemText(template, item, i)) : ""; };
        const title = locked ? t(props.lockedText) || "???" : t(card.title || props.item);
        const sub = locked ? "" : t(card.subtitle);
        const badge = locked ? "" : t(card.badge);
        const ref = card.imageField ? rowField(item, card.imageField) : null;
        const img = typeof ref === "string" && ref ? (api.resolveAssetUrl ? api.resolveAssetUrl(ref) : ref) : null;
        const hasMedia = !!card.imageField;
        const clickable = !!props.onRow && !locked;
        const Tag = clickable ? "button" : "div";
        return (
          <Tag
            key={i}
            type={clickable ? "button" : undefined}
            className={"yp-card" + (vertical ? "" : " yp-row yp-thumb") + (enter ? " yp-enter" : "")}
            data-locked={locked ? "" : undefined}
            aria-disabled={locked ? true : undefined}
            onClick={clickable ? function () { runSteps(props.onRow, [Object.assign({}, vars), item, i]); } : undefined}
            style={Object.assign({}, props.itemStyle || null, enter ? { animationDelay: Math.min(i, 12) * 40 + "ms" } : null)}
          >
            {badge && vertical ? <span className="yp-badge">{badge}</span> : null}
            {hasMedia ? (
              img || locked ? (
                <span className="yp-media" style={vertical ? { aspectRatio: "1 / " + ratio } : undefined}>
                  {img ? <span style={{ position: "absolute", inset: 0 }}><Img src={img} fit="cover" /></span> : null}
                  {locked ? <span className="yp-lock">{LOCK_ICON}</span> : null}
                </span>
              ) : <Tile tile={tiles[i]} title={title} style={vertical ? { aspectRatio: "1 / " + ratio } : undefined} />
            ) : null}
            <span className="yp-body">
              <span className="yp-title" style={props.titleStyle}>{title}</span>
              {sub ? <span className="yp-sub">{sub}</span> : null}
            </span>
            {badge && !vertical ? <span className="yp-badge">{badge}</span> : null}
          </Tag>
        );
      })}
    </div>
  );
}
`.trim();
