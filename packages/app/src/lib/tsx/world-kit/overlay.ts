/**
 * What the world kit draws over the 3D view: a reticle, the "press E" prompt,
 * captions, a place title, first-time control hints, the pause menu, the touch
 * thumbstick, and a black veil that lifts once the first frame is drawn.
 * Plain DOM inside the card's own container.
 */

export type Lang = "zh" | "en";

const TEXT = {
  zh: { resume: "继续", paused: "暂停", move: "移动", look: "看", use: "互动", run: "跑", jump: "跳", crouch: "蹲", drag: "拖动", tap: "点一下", menu: "菜单", stick: "左下角拖动走路", lookTouch: "右边拖动环顾", sound: "声音", on: "开", off: "关" },
  en: { resume: "Resume", paused: "Paused", move: "Move", look: "Look", use: "Use", run: "Run", jump: "Jump", crouch: "Crouch", drag: "Drag", tap: "Tap", menu: "Menu", stick: "Drag lower left to walk", lookTouch: "Drag right side to look", sound: "Sound", on: "On", off: "Off" },
};

const CSS = `
.ywk{position:absolute;inset:0;pointer-events:none;font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#e8e4da;user-select:none;-webkit-user-select:none;overflow:hidden}
.ywk *{box-sizing:border-box}
.ywk-veil{position:absolute;inset:0;background:#000;transition:opacity 1.2s ease;display:flex;align-items:center;justify-content:center}
.ywk-veil i{width:36px;height:2px;background:rgba(232,228,218,.7);animation:ywk-b 1.6s ease-in-out infinite}
@keyframes ywk-b{50%{opacity:.2;transform:scaleX(.6)}}
.ywk-ret{position:absolute;left:50%;top:50%;width:4px;height:4px;margin:-2px 0 0 -2px;border-radius:50%;background:rgba(240,236,226,.75);box-shadow:0 0 3px rgba(0,0,0,.8);transition:transform .15s,background .15s}
.ywk-ret.on{transform:scale(2.2);background:#fff}
.ywk-prompt{position:absolute;left:50%;top:calc(50% + 26px);transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:5px 12px 5px 6px;border-radius:999px;background:rgba(10,12,14,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);font-size:13px;letter-spacing:.04em;white-space:nowrap;opacity:0;transition:opacity .15s}
.ywk-prompt.on{opacity:1}
.ywk-key{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 6px;border-radius:5px;background:rgba(240,236,226,.92);color:#15171a;font:600 11px/1 system-ui,sans-serif;letter-spacing:.02em}
.ywk-cap{position:absolute;left:50%;bottom:max(12%,64px);transform:translateX(-50%);width:min(760px,88%);text-align:center;opacity:0;transition:opacity .35s}
.ywk-cap.on{opacity:1}
.ywk-who{font:600 11px/1 system-ui,sans-serif;letter-spacing:.32em;text-transform:uppercase;margin-bottom:10px}
.ywk-say{font:400 clamp(16px,2.1vw,23px)/1.45 Georgia,"Noto Serif SC","Source Han Serif SC","Songti SC","SimSun",serif;color:#f1ede4;text-shadow:0 1px 2px rgba(0,0,0,.9),0 0 18px rgba(0,0,0,.6)}
.ywk-place{position:absolute;left:max(20px,4%);top:max(18px,5%);font:600 11px/1.9 system-ui,sans-serif;letter-spacing:.26em;text-transform:uppercase;text-shadow:0 1px 2px rgba(0,0,0,.8);opacity:0;transition:opacity 1.2s}
.ywk-place.on{opacity:.85}
.ywk-place small{display:block;font:500 10px/1.6 ui-monospace,Consolas,monospace;letter-spacing:.22em;opacity:.7}
.ywk-hints{position:absolute;left:50%;bottom:max(18px,4%);transform:translateX(-50%);display:flex;gap:14px;flex-wrap:wrap;justify-content:center;font:600 11px/1 system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;opacity:0;transition:opacity .6s;white-space:nowrap}
.ywk-hints.on{opacity:.85}
.ywk-hints span{display:inline-flex;align-items:center;gap:7px;text-shadow:0 1px 2px rgba(0,0,0,.8)}
.ywk-pause{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 max(24px,12%);background:rgba(6,8,10,.62);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;transition:opacity .2s;pointer-events:none}
.ywk-pause.on{opacity:1;pointer-events:auto}
.ywk-pause h2{margin:0 0 4px;font:700 clamp(26px,4vw,40px)/1.1 system-ui,sans-serif;letter-spacing:.04em}
.ywk-pause .sub{font:600 10px/1 system-ui,sans-serif;letter-spacing:.3em;text-transform:uppercase;opacity:.6;margin-bottom:26px}
.ywk-pause button{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:space-between;width:min(300px,100%);padding:11px 14px;margin:2px 0;border-left:2px solid transparent;font:600 13px/1 system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase}
.ywk-pause button:hover,.ywk-pause button:focus-visible{background:rgba(255,255,255,.07);border-left-color:#e8e4da}
.ywk-pause .keys{margin-top:26px;display:grid;grid-template-columns:auto 1fr;gap:8px 14px;font-size:12px;opacity:.75;width:min(300px,100%)}
.ywk-stick{position:absolute;width:112px;height:112px;margin:-56px 0 0 -56px;border-radius:50%;border:1.5px solid rgba(240,236,226,.35);background:rgba(10,12,14,.18);opacity:0;transition:opacity .15s}
.ywk-stick.on{opacity:1}
.ywk-stick i{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(240,236,226,.55)}
.ywk-err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;background:#0b0c0e;font-size:14px;opacity:.9}
@media (pointer:coarse){.ywk-ret{display:none}}
`;

export interface Overlay {
  root: HTMLDivElement;
  ready(): void;
  target(label: string | null, touch: boolean): void;
  say(text: string, who?: string, color?: string): void;
  clearSay(): void;
  place(title: string, sub?: string): void;
  hints(show: boolean, touch: boolean, opts: { jump: boolean; crouch: boolean; run: boolean }): void;
  pause(show: boolean, name: string): void;
  /** The pause menu's sound switch: null hides it (a world with no sound). */
  sound: { muted: boolean; toggle: () => void } | null;
  stick(x: number, y: number, dx: number, dy: number, on: boolean): void;
  error(message: string): void;
  onResume: () => void;
  dispose(): void;
}

export function createOverlay(container: HTMLElement, lang: Lang): Overlay {
  const t = TEXT[lang];
  const doc = container.ownerDocument;
  const style = doc.createElement("style");
  style.textContent = CSS;
  const root = doc.createElement("div");
  root.className = "ywk";
  root.appendChild(style);
  const el = (cls: string, html = "") => { const d = doc.createElement("div"); d.className = cls; d.innerHTML = html; root.appendChild(d); return d; };
  const ret = el("ywk-ret");
  const prompt = el("ywk-prompt");
  const cap = el("ywk-cap", '<div class="ywk-who"></div><div class="ywk-say"></div>');
  const place = el("ywk-place");
  const hints = el("ywk-hints");
  const stick = el("ywk-stick", "<i></i>");
  const pause = el("ywk-pause");
  const veil = el("ywk-veil", "<i></i>");
  container.appendChild(root);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

  const api: Overlay = {
    root,
    onResume: () => {},
    sound: null,
    ready() { veil.style.opacity = "0"; setTimeout(() => veil.remove(), 1300); },
    target(label, touch) {
      ret.classList.toggle("on", Boolean(label));
      if (label) {
        prompt.innerHTML = touch ? `<span class="ywk-key">${t.tap}</span>${esc(label)}` : `<span class="ywk-key">E</span>${esc(label)}`;
        prompt.classList.add("on");
      } else prompt.classList.remove("on");
    },
    say(text, who, color) {
      const w = cap.firstElementChild as HTMLElement, s = cap.lastElementChild as HTMLElement;
      w.textContent = who || "";
      w.style.display = who ? "" : "none";
      w.style.color = color || "#d9644a";
      s.textContent = text;
      cap.classList.toggle("on", Boolean(text));
    },
    clearSay() { cap.classList.remove("on"); },
    place(title, sub) {
      place.innerHTML = esc(title) + (sub ? `<small>${esc(sub)}</small>` : "");
      place.classList.toggle("on", Boolean(title));
    },
    hints(show, touch, o) {
      if (show) {
        hints.innerHTML = touch
          ? `<span>${t.stick}</span><span>${t.lookTouch}</span>`
          : `<span><b class="ywk-key">W A S D</b>${t.move}</span><span><b class="ywk-key">E</b>${t.use}</span>` +
            (o.run ? `<span><b class="ywk-key">Shift</b>${t.run}</span>` : "") +
            (o.jump ? `<span><b class="ywk-key">Space</b>${t.jump}</span>` : "") +
            (o.crouch ? `<span><b class="ywk-key">C</b>${t.crouch}</span>` : "") +
            `<span><b class="ywk-key">Esc</b>${t.menu}</span>`;
      }
      hints.classList.toggle("on", show);
    },
    pause(show, name) {
      if (show) {
        pause.innerHTML = `<div class="sub">${esc(t.paused)}</div><h2>${esc(name || t.paused)}</h2><div style="height:22px"></div>` +
          `<button type="button" data-r>${t.resume}<span class="ywk-key">Esc</span></button>` +
          (api.sound ? `<button type="button" data-s>${t.sound}<span class="ywk-key">${api.sound.muted ? t.off : t.on}</span></button>` : "") +
          `<div class="keys"><span class="ywk-key">W A S D</span><span>${t.move}</span><span class="ywk-key">E</span><span>${t.use}</span>` +
          `<span class="ywk-key">Shift</span><span>${t.run}</span><span class="ywk-key">Space</span><span>${t.jump}</span><span class="ywk-key">C</span><span>${t.crouch}</span></div>`;
        (pause.querySelector("[data-r]") as HTMLElement).onclick = (e) => { e.stopPropagation(); api.onResume(); };
        const sb = pause.querySelector("[data-s]") as HTMLElement | null;
        if (sb) sb.onclick = (e) => {
          e.stopPropagation();
          api.sound?.toggle();
          (sb.lastElementChild as HTMLElement).textContent = api.sound?.muted ? t.off : t.on;
        };
      }
      pause.classList.toggle("on", show);
    },
    stick(x, y, dx, dy, on) {
      stick.classList.toggle("on", on);
      if (!on) return;
      stick.style.left = x + "px"; stick.style.top = y + "px";
      (stick.firstElementChild as HTMLElement).style.transform = `translate(${dx}px,${dy}px)`;
    },
    error(message) {
      veil.remove();
      el("ywk-err").textContent = message;
    },
    dispose() { root.remove(); },
  };
  return api;
}
