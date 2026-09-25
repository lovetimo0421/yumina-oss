import qrcode from "qrcode-generator";

/**
 * The share poster, in the house style of the earlier 「分享你的 YUMINA 时刻」
 * social event: warm purple, soft gold / violet / pink circles, gold numbers,
 * numbered steps, a pink "heads-up" pill — plus the mushie mascot art. 3:4
 * (1080×1440), the size Xiaohongshu shows uncropped and the old poster used.
 *
 * Drawn on a canvas in the browser with the inviter's own code and a QR code
 * to their invite link. No server.
 */

export interface PosterText {
  brand: string;        // "YUMINA · 邀请赛"
  line1: string;        // "邀请好友"
  line2: string;        // "一起瓜分"
  amount: string;       // "$1,000"
  sub: string;          // "好友玩得越多，你分得越多"
  capLabel: string;     // "每位好友最多为你带来"
  capValue: string;     // "64"
  capUnit: string;      // "张券"
  capDetail: string;    // "注册 +1 · 隔天回来 +3 · 持续玩最多 +60"
  steps: { title: string; body: string }[];
  tipLabel: string;     // "小提醒"
  tip: string;          // "新朋友注册就送 500 蘑菇"
  codeLabel: string;    // "我的邀请码"
  code: string;
  scan: string;         // "扫码加入"
  url: string;          // full invite URL, encoded in the QR
  artUrl?: string;      // mascot art, same-origin
}

const W = 1080;
const H = 1440;
const BG = "#241b37";
const INK = "#f6f1e7";
const LILAC = "rgba(214,200,255,0.72)";
const GOLD = "#e8b64c";
const GOLD_SOFT = "#f3d58c";
const PINK = "#f08ab4";
const SANS = `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", -apple-system, "Segoe UI", sans-serif`;

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number) {
  let cx = x;
  ctx.textAlign = "left";
  for (const c of [...text]) {
    ctx.fillText(c, cx, y);
    cx += ctx.measureText(c).width + tracking;
  }
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number, weight: number, size: number) {
  let s = size;
  ctx.font = `${weight} ${s}px ${SANS}`;
  while (ctx.measureText(text).width > max && s > 12) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${SANS}`;
  }
}

/** Wrap CJK or Latin text into at most `lines` lines within `max` px. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number, lines = 2): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of [...text]) {
    if (ctx.measureText(cur + ch).width > max && cur) {
      out.push(cur);
      cur = ch.trimStart();
      if (out.length === lines - 1) break;
    } else cur += ch;
  }
  const rest = text.slice(out.join("").length).trimStart();
  if (out.length < lines && rest) out.push(rest);
  return out.slice(0, lines);
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number) {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 2;
  rr(ctx, x - 14, y - 14, size + 28, size + 28, 24);
  ctx.fillStyle = "#fff";
  ctx.fill();
  const cell = size / (n + quiet * 2);
  ctx.fillStyle = "#241b37";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
}

export async function renderInviteRacePoster(text: PosterText): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  try { await document.fonts?.ready; } catch { /* draw with what we have */ }
  const art = text.artUrl ? await loadImage(text.artUrl) : null;

  const L = 84;
  const R = W - 84;

  // ── Background: warm purple with a lighter middle and the three soft circles. ──
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.45, H * 0.34, 40, W * 0.45, H * 0.34, 760);
  glow.addColorStop(0, "rgba(96,72,150,0.55)");
  glow.addColorStop(1, "rgba(36,27,55,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  circle(ctx, -6, -14, 92, "#d9a845");
  circle(ctx, W - 20, 70, 210, "rgba(90,66,140,0.75)");
  circle(ctx, W - 40, H - 30, 170, "rgba(222,124,168,0.85)");

  // ── Mascot art, right side, melted into the purple with a soft oval mask
  //    (its own background is a different purple, so hard edges would show). ──
  if (art) {
    const ax = 380, ay = 110, aw = W - ax + 40, ah = 560;
    const sx = art.naturalWidth * 0.4, sw = art.naturalWidth * 0.6;
    const sh = Math.min(art.naturalHeight, sw * (ah / aw)), sy = Math.max(0, (art.naturalHeight - sh) * 0.3);
    const off = document.createElement("canvas");
    off.width = aw;
    off.height = ah;
    const o = off.getContext("2d")!;
    o.drawImage(art, sx, sy, sw, sh, 0, 0, aw, ah);
    o.globalCompositeOperation = "destination-in";
    const mask = o.createRadialGradient(aw * 0.58, ah * 0.5, Math.min(aw, ah) * 0.22, aw * 0.58, ah * 0.5, Math.max(aw, ah) * 0.55);
    mask.addColorStop(0, "rgba(0,0,0,1)");
    mask.addColorStop(0.62, "rgba(0,0,0,0.85)");
    mask.addColorStop(1, "rgba(0,0,0,0)");
    o.fillStyle = mask;
    o.fillRect(0, 0, aw, ah);
    // …and fade the top and bottom edges on their own, so no straight line survives.
    const vert = o.createLinearGradient(0, 0, 0, ah);
    vert.addColorStop(0, "rgba(0,0,0,0)");
    vert.addColorStop(0.22, "rgba(0,0,0,1)");
    vert.addColorStop(0.72, "rgba(0,0,0,1)");
    vert.addColorStop(1, "rgba(0,0,0,0)");
    o.fillStyle = vert;
    o.fillRect(0, 0, aw, ah);
    ctx.drawImage(off, ax, ay);
  }

  // ── Masthead + headline. ──
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = GOLD;
  ctx.font = `800 30px ${SANS}`;
  spaced(ctx, text.brand, L + 40, 108, 9);

  ctx.fillStyle = INK;
  ctx.font = `900 96px ${SANS}`;
  ctx.textAlign = "left";
  ctx.fillText(text.line1, L, 250);
  ctx.fillText(text.line2, L, 370);
  ctx.save();
  ctx.fillStyle = GOLD;
  ctx.shadowColor = "rgba(232,182,76,0.45)";
  ctx.shadowBlur = 30;
  ctx.font = `900 118px ${SANS}`;
  ctx.fillText(text.amount, L - 4, 500);
  ctx.restore();

  ctx.fillStyle = LILAC;
  fit(ctx, text.sub, 520, 500, 34);
  ctx.fillText(text.sub, L, 566);

  // ── The cap card: how much one friend is worth. ──
  const cy = 640, ch = 280;
  rr(ctx, L, cy, R - L, ch, 34);
  const cardFill = ctx.createLinearGradient(0, cy, 0, cy + ch);
  cardFill.addColorStop(0, "rgba(30,21,48,0.92)");
  cardFill.addColorStop(1, "rgba(24,17,40,0.92)");
  ctx.fillStyle = cardFill;
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.1)";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.fillStyle = LILAC;
  ctx.font = `600 32px ${SANS}`;
  ctx.fillText(text.capLabel, W / 2, cy + 70);
  ctx.save();
  ctx.fillStyle = GOLD;
  ctx.shadowColor = "rgba(232,182,76,0.5)";
  ctx.shadowBlur = 36;
  ctx.font = `900 132px ${SANS}`;
  const vw = ctx.measureText(text.capValue).width;
  ctx.font = `800 44px ${SANS}`;
  const uw = ctx.measureText(text.capUnit).width;
  const startX = W / 2 - (vw + 18 + uw) / 2;
  ctx.textAlign = "left";
  ctx.font = `900 132px ${SANS}`;
  ctx.fillText(text.capValue, startX, cy + 196);
  ctx.restore();
  ctx.fillStyle = GOLD_SOFT;
  ctx.font = `800 44px ${SANS}`;
  ctx.textAlign = "left";
  ctx.fillText(text.capUnit, startX + vw + 18, cy + 196);
  ctx.textAlign = "center";
  ctx.fillStyle = INK;
  fit(ctx, text.capDetail, R - L - 80, 600, 32);
  ctx.fillText(text.capDetail, W / 2, cy + 248);

  // ── Three numbered steps. ──
  const sy = 966;
  const colW = (R - L) / text.steps.length;
  text.steps.forEach((s, i) => {
    const x = L + colW * i;
    circle(ctx, x + 28, sy, 28, GOLD);
    ctx.fillStyle = "#2a1f3f";
    ctx.font = `900 32px ${SANS}`;
    ctx.textAlign = "center";
    ctx.fillText(String(i + 1), x + 28, sy + 11);
    ctx.textAlign = "left";
    ctx.fillStyle = INK;
    fit(ctx, s.title, colW - 24, 800, 36);
    ctx.fillText(s.title, x, sy + 82);
    ctx.fillStyle = LILAC;
    ctx.font = `500 26px ${SANS}`;
    wrap(ctx, s.body, colW - 30, 2).forEach((line, j) => ctx.fillText(line, x, sy + 126 + j * 36));
  });

  // ── Heads-up pill. ──
  const py = 1150;
  rr(ctx, L, py, R - L, 68, 20);
  ctx.fillStyle = "rgba(240,138,180,0.12)";
  ctx.fill();
  ctx.strokeStyle = "rgba(240,138,180,0.35)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.font = `800 26px ${SANS}`;
  const tlw = ctx.measureText(text.tipLabel).width + 32;
  rr(ctx, L + 18, py + 15, tlw, 38, 19);
  ctx.fillStyle = PINK;
  ctx.fill();
  ctx.fillStyle = "#3a1830";
  ctx.textAlign = "left";
  ctx.fillText(text.tipLabel, L + 34, py + 44);
  ctx.fillStyle = INK;
  fit(ctx, text.tip, R - L - tlw - 60, 600, 28);
  ctx.fillText(text.tip, L + 18 + tlw + 20, py + 44);

  // ── Code + QR. ──
  const qSize = 122;
  const qx = R - qSize - 14, qy = H - qSize - 50;
  drawQr(ctx, text.url, qx, qy, qSize);
  ctx.textAlign = "left";
  ctx.fillStyle = LILAC;
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText(text.codeLabel, L, qy + 6);
  ctx.font = `900 64px ${SANS}`;
  const cw = ctx.measureText(text.code).width + 44;
  rr(ctx, L, qy + 26, cw, 88, 22);
  ctx.fillStyle = "rgba(232,182,76,0.14)";
  ctx.fill();
  ctx.strokeStyle = "rgba(232,182,76,0.55)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = GOLD_SOFT;
  ctx.fillText(text.code, L + 22, qy + 94);
  ctx.textAlign = "right";
  ctx.fillStyle = LILAC;
  ctx.font = `600 24px ${SANS}`;
  ctx.fillText(text.scan, qx - 40, qy + qSize / 2 + 8);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("poster"))), "image/png"));
}
