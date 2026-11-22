import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PUBLIC_ORIGIN, env } from "../env.js";

/**
 * The view an MCP host (Claude, ChatGPT) draws inside the chat for our tools:
 * pictures and videos as they finish, a price to confirm before a big spend,
 * the creator's balance, and a playtest the creator can keep playing.
 *
 * One self-contained page (MCP Apps, `text/html;profile=mcp-app`). It talks to
 * the host only through the MCP Apps bridge: it reads the tool's
 * structuredContent, and its buttons call our own tools back through the host
 * (wait_jobs, generate_*, playtest), so it needs no network of its own beyond
 * loading the creator's pictures from our /cdn.
 */

export const VIEW_URI = "ui://yumina/studio-v1.html";
export const VIEW_MIME = "text/html;profile=mcp-app";

/** Tools whose results the view draws. */
export const VIEW_TOOLS = new Set(["generate_image", "generate_images", "generate_video", "wait_jobs", "list_generations", "get_balance", "playtest", "upload_media", "confirm_upload", "import_media_url",
  "design_voice", "speak", "search_market", "install_bundle", "run_media_tool", "browse_library"]);

export const VIEW_META = { ui: { resourceUri: VIEW_URI }, "ui/resourceUri": VIEW_URI };

export function viewResourceMeta() {
  // The library view uploads straight to storage (the same signed PUT the website uses), so it may connect there.
  let storage: string[] = [];
  try { storage = [new URL(env.AWS_ENDPOINT_URL).origin]; } catch { /* no storage endpoint configured */ }
  return { ui: { csp: { resourceDomains: [PUBLIC_ORIGIN], connectDomains: storage }, prefersBorder: true } };
}

let cached: string | null = null;

/** The ext-apps client, rewritten from an ES module's trailing `export {…}` to a global, so it runs in a classic script. */
function bridgeScript(): string {
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const at = source.lastIndexOf("export{");
  const end = source.indexOf("}", at);
  if (at < 0 || end < 0) throw new Error("ext-apps bundle has no trailing export");
  const names = source.slice(at + "export{".length, end).split(",").map((s) => s.trim()).filter(Boolean)
    .map((pair) => { const [local, exported] = pair.split(/\s+as\s+/); return `${JSON.stringify(exported ?? local)}:${local}`; });
  return `(function(){${source.slice(0, at)};globalThis.McpApps={${names.join(",")}};})();`;
}

export function viewHtml(): string {
  if (cached) return cached;
  cached = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${CSS}</style></head><body><div id="root"><div class="muted pad">…</div></div>
<script>${bridgeScript().replace(/<\/script/gi, "<\\/script")}</script>
<script>${CLIENT}</script></body></html>`;
  return cached;
}

const CSS = `
:root{--bg:#fff;--fg:#17181c;--muted:#6b6f7a;--line:#e3e5ea;--soft:#f3f4f7;--accent:#0e7c72;--accent-fg:#fff;--warn:#9a6b00;--bad:#b42318;
--font:ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color-scheme:light}
:root[data-theme=dark]{--bg:#1e1f23;--fg:#ecedf0;--muted:#9a9eaa;--line:#33353c;--soft:#26282d;--accent:#3cc2b3;--accent-fg:#0b1f1d;--warn:#e5b54a;--bad:#f97066;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--font)}
.pad{padding:14px 16px}.muted{color:var(--muted)}.small{font-size:12px}
.head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:12px 16px 4px}
.head b{font-size:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;padding:8px 16px 14px}
.tile{position:relative;border-radius:8px;overflow:hidden;background:var(--soft);border:1px solid var(--line);aspect-ratio:3/4;display:flex;align-items:center;justify-content:center}
.tile img,.tile video{width:100%;height:100%;object-fit:cover;display:block;cursor:pointer}
.tile audio{width:92%}
.tile .ref{position:absolute;left:6px;bottom:6px;right:6px;font:11px ui-monospace,Consolas,monospace;background:rgba(0,0,0,.6);color:#fff;padding:2px 6px;border-radius:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile .st{font-size:12px;color:var(--muted);text-align:center;padding:8px}
.spin{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--accent);animation:sp 1s linear infinite;margin:0 auto 6px}
@keyframes sp{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.card{margin:12px 16px;padding:14px;border:1px solid var(--line);border-radius:10px;display:grid;gap:8px}
.big{font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.1}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
button{font:inherit;border-radius:8px;border:1px solid var(--line);background:var(--soft);color:var(--fg);padding:6px 12px;cursor:pointer}
button.pri{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{color:var(--bad)}.turns{display:grid;gap:10px;padding:8px 16px}
.me{justify-self:end;max-width:85%;background:var(--soft);border:1px solid var(--line);border-radius:12px 12px 2px 12px;padding:6px 10px;white-space:pre-wrap}
.ai{white-space:pre-wrap;line-height:1.65}
.chips{display:flex;gap:4px;flex-wrap:wrap}.chip{font:11px ui-monospace,Consolas,monospace;padding:1px 6px;border-radius:4px;background:var(--soft);border:1px solid var(--line)}
.say{display:flex;gap:8px;padding:8px 16px 14px}.say input,.field{flex:1;min-width:0;font:inherit;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.vlist{display:grid;gap:8px}.vrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.vrow audio{flex:1;min-width:180px;height:34px}
.packs{display:grid;gap:10px;padding:8px 16px 14px}.pack{display:grid;grid-template-columns:96px 1fr;gap:12px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.pack img,.pack .nocover{width:96px;height:100%;min-height:96px;object-fit:cover;background:var(--soft)}.pbody{display:grid;gap:4px;padding:10px 12px 10px 0;min-width:0}
.pdesc{color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tab{padding:3px 10px;font-size:12px}.tab.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.tile.pick{cursor:pointer}.tile.pick.sel{outline:2px solid var(--accent);outline-offset:2px}
`;

// The page's script: plain JS, no build step. Strings in zh and en, picked from the host's locale.
const CLIENT = String.raw`
(function(){
var A = globalThis.McpApps; var app = new A.App({ name: "Yumina", version: "1.0.0" }, {}, { autoResize: true });
var root = document.getElementById("root");
var zh = /^zh/i.test((navigator.language||""));
var T = function(z,e){ return zh ? z : e; };
var input = {}; var state = null; var busy = false;

function theme(ctx){ if(!ctx) return; if(ctx.theme) document.documentElement.dataset.theme = ctx.theme; if(ctx.locale) zh = /^zh/i.test(ctx.locale); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c];}); }
function el(html){ var d=document.createElement("div"); d.innerHTML=html; return d; }
function open(url){ app.openLink({ url: url }).catch(function(){}); }
async function call(name, args){ var r = await app.callServerTool({ name: name, arguments: args }); return r; }

function media(r){
  var m = r.mimeType || ""; var u = esc(r.url);
  if (m.indexOf("video/")===0) return '<video src="'+u+'" muted loop playsinline preload="metadata" data-url="'+u+'"></video>';
  if (m.indexOf("audio/")===0) return '<audio src="'+u+'" controls preload="none"></audio>';
  if (m.indexOf("model/")===0 || /gltf|glb/.test(m)) return '<div class="st">3D · '+esc(r.ref)+'</div>';
  return '<img src="'+u+'" alt="" loading="lazy" data-url="'+u+'">';
}
function tiles(items, pending){
  var html = "";
  (items||[]).forEach(function(it){
    if (it.status === "succeeded" && it.results && it.results.length) it.results.forEach(function(r){ html += '<div class="tile">'+media(r)+'<span class="ref" title="'+esc(r.ref)+'">'+esc(r.ref)+'</span></div>'; });
    else if (it.status === "failed" || it.status === "cancelled") html += '<div class="tile"><div class="st err">'+T("没成功","Failed")+(it.error?'<br>'+esc(it.error):'')+'<br>'+T("已自动退款","Refunded")+'</div></div>';
    else html += '<div class="tile"><div class="st"><div class="spin"></div>'+T("生成中…","Working…")+'</div></div>';
  });
  (pending||[]).forEach(function(id){ if(!(items||[]).some(function(i){return i.id===id;})) html += '<div class="tile"><div class="st"><div class="spin"></div>'+T("生成中…","Working…")+'</div></div>'; });
  return html;
}
function bindMedia(){
  root.querySelectorAll("img[data-url],video[data-url]").forEach(function(n){ n.onclick=function(){ open(n.getAttribute("data-url")); }; });
  root.querySelectorAll("video").forEach(function(v){ v.onmouseenter=function(){v.play().catch(function(){});}; v.onmouseleave=function(){v.pause();}; });
}

function drawGallery(s){
  var items = s.items||[]; var pending = s.pending||[];
  var done = items.filter(function(i){return i.status==="succeeded";}).length;
  var title = s.title==="history" ? T("我做过的","My generations") : s.title==="upload" ? T("已放进素材库","In your library") : T("生成结果","Results");
  var meta = pending.length ? T("还有 "+pending.length+" 个在做", pending.length+" still working") : items.length ? T(done+" 个完成", done+" done") : "";
  root.innerHTML = '<div class="head"><b>'+title+'</b><span class="muted small">'+meta+'</span></div>'
    + (items.length||pending.length ? '<div class="grid">'+tiles(items,pending)+'</div>' : '<div class="pad muted">'+T("还没有作品","Nothing yet")+'</div>');
  bindMedia();
}
function renderGallery(s){ drawGallery(s); if ((s.pending||[]).length) poll(s); }
var polling = false;
async function poll(s){
  if (polling) return; polling = true;
  var ids = s.pending.slice(); var byId = {}; (s.items||[]).forEach(function(i){ byId[i.id]=i; });
  try {
    for (var round=0; round<20 && ids.length; round++){
      var r = await call("wait_jobs", { job_ids: ids });
      var sc = r && r.structuredContent; if (!sc) break;
      (sc.items||[]).forEach(function(i){ byId[i.id]=i; });
      ids = sc.pending||[];
      state = { view:"gallery", title: s.title, items: Object.keys(byId).map(function(k){return byId[k];}), pending: ids };
      drawGallery(state);
    }
  } catch(e) { } finally { polling = false; }
}

function renderQuote(s){
  var usd = (Number(s.priceMushies)/1000).toFixed(2);
  root.innerHTML = '<div class="card"><div class="muted small">'+(s.tool==="generate_video"?T("生成视频","Video"):s.tool==="run_media_tool"?T("工具","Tool"):T("生成图片","Pictures"))+(s.model?' · '+esc(s.model):'')+(s.clip?' · '+esc(s.clip):'')+(s.pictures?' · '+Number(s.pictures)+T(" 张"," pictures"):'')+'</div>'
    + '<div class="big">'+Number(s.priceMushies)+' <span class="small muted">'+T("蘑菇","mushies")+' · US$'+usd+'</span></div>'
    + (s.typicalWaitSeconds?'<div class="muted small">'+T("大约 "+Number(s.typicalWaitSeconds)+" 秒","About "+Number(s.typicalWaitSeconds)+" s")+'</div>':'')
    + '<div class="row"><button class="pri" id="go" type="button">'+T("确认生成","Generate")+'</button><span class="muted small" id="msg"></span></div></div>';
  document.getElementById("go").onclick = async function(){
    var b=this; b.disabled=true; document.getElementById("msg").textContent=T("提交中…","Starting…");
    try { var r = await call(s.tool, s.args); var sc = r && r.structuredContent;
      if (r && r.isError) { document.getElementById("msg").innerHTML='<span class="err">'+esc((r.content&&r.content[0]&&r.content[0].text)||T("没能开始","Could not start"))+'</span>'; b.disabled=false; return; }
      if (sc) render(sc); app.updateModelContext && app.updateModelContext({ content:[{ type:"text", text: "The creator confirmed and started "+s.tool+" ("+s.priceMushies+" mushies). Job ids: "+((sc&&sc.pending)||[]).join(", ") }] }).catch(function(){});
    } catch(e){ document.getElementById("msg").innerHTML='<span class="err">'+esc(e.message||e)+'</span>'; b.disabled=false; }
  };
}

function renderBalance(s){
  root.innerHTML = '<div class="card"><div class="muted small">'+T("余额","Balance")+' · '+esc(s.plan)+'</div>'
    + '<div class="big">'+Number(s.mushies).toLocaleString()+' <span class="small muted">'+T("蘑菇","mushies")+'</span></div>'
    + '<div class="muted small">'+T("约 US$","≈ US$")+(Number(s.mushies)/1000).toFixed(2)+(s.renews?' · '+T("下次发放 ","renews ")+esc(String(s.renews).slice(0,10)):'')+'</div>'
    + '<div class="row"><button id="top" type="button">'+T("去充值","Top up")+'</button></div></div>';
  document.getElementById("top").onclick=function(){ open(s.topUp); };
}

function turnHtml(t){
  var chips = "";
  var sc = t.stateChanges; var show = function(v){ return esc(typeof v==="object"?JSON.stringify(v):v); };
  if (Array.isArray(sc)) sc.slice(0,8).forEach(function(c){ if(c && typeof c==="object") chips += '<span class="chip">'+esc(c.variableId||c.id||"")+' '+(c.oldValue!==undefined?show(c.oldValue)+' → ':'→ ')+show(c.newValue)+'</span>'; });
  else if (sc && typeof sc === "object") Object.keys(sc).slice(0,8).forEach(function(k){ chips += '<span class="chip">'+esc(k)+' → '+show(sc[k])+'</span>'; });
  return '<div class="me">'+esc(t.player)+'</div>' + (t.error ? '<div class="err">'+esc(t.error)+'</div>' : '<div class="ai">'+esc(t.reply)+'</div>') + (chips?'<div class="chips">'+chips+'</div>':'');
}
function renderPlaytest(s){
  state = s;
  root.innerHTML = '<div class="head"><b>'+T("试玩","Playtest")+'</b><span class="muted small">'+T("每一步按真实回合扣费","Each move costs a real turn")+'</span></div>'
    + '<div class="turns" id="turns">'+(s.turns||[]).map(turnHtml).join("")+'</div>'
    + '<div class="say"><input id="move" placeholder="'+T("接下来做什么…","What do you do next…")+'" autocomplete="off"><button class="pri" id="send" type="button">'+T("继续","Play")+'</button></div>';
  var box0=document.getElementById("move");
  box0.onkeydown=function(ev){ if(ev.key==="Enter" && !ev.isComposing){ ev.preventDefault(); document.getElementById("send").click(); } };
  document.getElementById("send").onclick = async function(){
    var box=document.getElementById("move"); var move=box.value.trim(); if(!move||busy) return;
    busy=true; document.getElementById("send").disabled=true; box.value="";
    var turns=document.getElementById("turns"); turns.insertAdjacentHTML("beforeend",'<div class="me">'+esc(move)+'</div><div class="ai muted" id="wait">…</div>');
    try {
      var args = { moves:[move], session_id: s.sessionId }; if (input.card_id) args.card_id = input.card_id;
      var r = await call("playtest", args); var sc = r && r.structuredContent;
      if (sc && sc.view==="playtest"){ s.turns = (s.turns||[]).concat(sc.turns||[]); s.sessionId = sc.sessionId || s.sessionId; renderPlaytest(s); }
      else { document.getElementById("wait").outerHTML='<div class="err">'+esc((r.content&&r.content[0]&&r.content[0].text)||"")+'</div>'; }
    } catch(e){ var w=document.getElementById("wait"); if(w) w.outerHTML='<div class="err">'+esc(e.message||e)+'</div>'; }
    busy=false; var b=document.getElementById("send"); if(b) b.disabled=false;
  };
}

// Tell the chat what the creator did here: a message from them when the host takes one, else context for the next turn.
function say(text){
  var msg = { role: "user", content: [{ type: "text", text: text }] };
  return app.sendMessage(msg).catch(function(){ return app.updateModelContext({ content: [{ type: "text", text: text }] }); }).catch(function(){});
}

function renderVoices(s){
  var list = (s.candidates||[]).map(function(c, i){
    return '<div class="vrow"><span class="small muted">#'+(i+1)+' · '+Number(c.seconds)+'s</span><audio src="'+esc(c.url)+'" controls preload="none"></audio>'
      + '<button type="button" class="pri" data-i="'+i+'">'+T("就用这个","Keep this")+'</button></div>';
  }).join("");
  root.innerHTML = '<div class="head"><b>'+T("试听新声音","New voices")+'</b><span class="muted small">'+esc(String(s.description||"").slice(0,40))+'</span></div>'
    + '<div class="pad vlist"><div class="row"><input id="vname" class="field" placeholder="'+T("给声音起个名字","Name the voice")+'" maxlength="40"><span class="muted small" id="vmsg"></span></div>'+list+'</div>';
  root.querySelectorAll("button[data-i]").forEach(function(b){ b.onclick = async function(){
    var c = s.candidates[Number(b.getAttribute("data-i"))]; var name = document.getElementById("vname").value.trim() || String(s.description||"").slice(0,20) || "Voice";
    root.querySelectorAll("button[data-i]").forEach(function(x){ x.disabled = true; });
    document.getElementById("vmsg").textContent = T("保存中…","Saving…");
    try { var r = await call("save_voice", { token: c.token, name: name });
      if (r.isError) throw new Error((r.content&&r.content[0]&&r.content[0].text)||"");
      var v = r.structuredContent || JSON.parse((r.content&&r.content[0]&&r.content[0].text)||"{}");
      document.getElementById("vmsg").textContent = T("已存进我的声音：","Saved to My voices: ")+(v.name||name);
      say(T("我选了第 "+(Number(b.getAttribute("data-i"))+1)+" 个声音，存成了「"+(v.name||name)+"」(voiceId "+v.voiceId+")。","I kept voice #"+(Number(b.getAttribute("data-i"))+1)+" as \""+(v.name||name)+"\" (voiceId "+v.voiceId+")."));
    } catch(e){ document.getElementById("vmsg").innerHTML='<span class="err">'+esc(e.message||e)+'</span>'; root.querySelectorAll("button[data-i]").forEach(function(x){ x.disabled = false; }); }
  }; });
}

function renderPacks(s){
  var packs = s.packs||[];
  root.innerHTML = '<div class="head"><b>'+T("资源市场","Resource market")+'</b><span class="muted small">'+packs.length+'</span></div>'
    + (packs.length ? '<div class="packs">'+packs.map(function(p, i){
      return '<div class="pack">'+(p.cover?'<img src="'+esc(p.cover)+'" alt="" loading="lazy">':'<div class="nocover"></div>')
        + '<div class="pbody"><b>'+esc(p.name)+'</b><span class="muted small">'+esc(p.by||"")+' · '+T("用过 ","used ")+Number(p.installs||0)+'</span>'
        + '<span class="small pdesc">'+esc(p.description||"")+'</span>'
        + '<div class="row"><button type="button" data-open="'+i+'">'+T("看看","View")+'</button><button type="button" class="pri" data-put="'+i+'">'+T("装进卡","Add to a card")+'</button></div></div></div>';
    }).join("")+'</div>' : '<div class="pad muted">'+T("没找到","Nothing found")+'</div>');
  root.querySelectorAll("button[data-open]").forEach(function(b){ b.onclick=function(){ open(packs[Number(b.getAttribute("data-open"))].page); }; });
  root.querySelectorAll("button[data-put]").forEach(function(b){ b.onclick=async function(){
    var p = packs[Number(b.getAttribute("data-put"))];
    if (input.card_id) { b.disabled = true; var r = await call("install_bundle", { bundle_id: p.id, card_id: input.card_id }).catch(function(){ return null; });
      var link = r && r.structuredContent && r.structuredContent.link; if (link) open(link); b.disabled = false; }
    else say(T("把资源包「"+p.name+"」(id "+p.id+") 装进我的一张卡。","Add the pack \""+p.name+"\" (id "+p.id+") to one of my cards."));
  }; });
}

function renderInstall(s){
  root.innerHTML = '<div class="card"><div class="row"><button type="button" class="pri" id="inst">'+T("在编辑器里装进卡","Add it in the editor")+'</button></div></div>';
  document.getElementById("inst").onclick=function(){ open(s.link); };
}

function renderLibrary(s){
  state = s; var items = s.items||[]; var types = [["", T("全部","All")],["image",T("图片","Pictures")],["video",T("视频","Videos")],["audio",T("声音","Sounds")]];
  root.innerHTML = '<div class="head"><b>'+T("我的素材","My library")+'</b><span class="row">'
    + types.map(function(x){ return '<button type="button" class="tab'+((s.type||"")===x[0]?' on':'')+'" data-type="'+x[0]+'">'+x[1]+'</button>'; }).join("")
    + '<button type="button" class="pri" id="up">'+T("上传","Upload")+'</button><input type="file" id="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,audio/mpeg,audio/wav,audio/ogg,audio/mp4" hidden></span></div>'
    + '<div class="small muted" id="lmsg" style="padding:0 16px"></div>'
    + (items.length ? '<div class="grid">'+items.map(function(r, i){ return '<div class="tile pick" data-i="'+i+'" tabindex="0">'+media(r).replace(/ data-url="[^"]*"/,"")+'<span class="ref" title="'+esc(r.filename||r.ref)+'">'+esc(r.filename||r.ref)+'</span></div>'; }).join("")+'</div>'
      : '<div class="pad muted">'+T("素材库里还没有这类文件","Nothing of this kind yet")+'</div>');
  root.querySelectorAll("button[data-type]").forEach(function(b){ b.onclick = async function(){
    var r = await call("browse_library", b.getAttribute("data-type") ? { type: b.getAttribute("data-type") } : {}).catch(function(){ return null; });
    if (r && r.structuredContent) renderLibrary(r.structuredContent);
  }; });
  root.querySelectorAll(".tile.pick").forEach(function(t){ var pick = function(){
    var r = items[Number(t.getAttribute("data-i"))]; root.querySelectorAll(".tile.pick").forEach(function(x){ x.classList.remove("sel"); }); t.classList.add("sel");
    say(T("用这个：","Use this one: ")+r.ref+(r.filename?" ("+r.filename+")":""));
  }; t.onclick = pick; t.onkeydown = function(ev){ if(ev.key==="Enter"||ev.key===" "){ ev.preventDefault(); pick(); } }; });
  var file = document.getElementById("file");
  document.getElementById("up").onclick = function(){ file.click(); };
  file.onchange = async function(){
    var files = Array.prototype.slice.call(file.files||[]); var msg = document.getElementById("lmsg"); var added = [];
    for (var i=0;i<files.length;i++){
      var f = files[i]; msg.textContent = T("上传中 ","Uploading ")+(i+1)+"/"+files.length+" · "+f.name;
      try {
        var a = await call("upload_media", { filename: f.name, size_bytes: f.size, content_type: f.type || undefined });
        if (a.isError) throw new Error((a.content&&a.content[0]&&a.content[0].text)||"");
        var prep = a.structuredContent || JSON.parse(a.content[0].text);
        if (prep.uploadUrl) {
          var put = await fetch(prep.uploadUrl, { method: "PUT", headers: { "Content-Type": prep.headers["Content-Type"] }, body: f });
          if (!put.ok) throw new Error(T("存储拒绝了上传 (","Storage refused the upload (")+put.status+")");
          var c = await call("confirm_upload", prep.confirm);
          if (c.isError) throw new Error((c.content&&c.content[0]&&c.content[0].text)||"");
          var it = c.structuredContent && c.structuredContent.items && c.structuredContent.items[0] && c.structuredContent.items[0].results[0];
          if (it) added.push(it);
        } else if (prep.items && prep.items[0]) added.push(prep.items[0].results[0]);
      } catch(e) { msg.innerHTML = '<span class="err">'+esc(f.name)+': '+esc(e.message||e)+'</span>'; }
    }
    if (added.length) { renderLibrary({ view: "library", type: s.type, items: added.concat(items) });
      say(T("我上传了：","I uploaded: ")+added.map(function(x){ return x.ref+(x.filename?" ("+x.filename+")":""); }).join(", ")); }
    file.value = "";
  };
}

function render(s){
  if (!s || !s.view) return;
  state = s;
  if (s.view==="gallery") return renderGallery(s);
  if (s.view==="quote") return renderQuote(s);
  if (s.view==="balance") return renderBalance(s);
  if (s.view==="playtest") return renderPlaytest(s);
  if (s.view==="voices") return renderVoices(s);
  if (s.view==="packs") return renderPacks(s);
  if (s.view==="install") return renderInstall(s);
  if (s.view==="library") return renderLibrary(s);
}

app.ontoolinput = function(p){ input = (p && p.arguments) || {}; if(!state) root.innerHTML='<div class="pad muted"><div class="spin"></div></div>'; };
app.ontoolresult = function(p){ if (p && p.structuredContent) render(p.structuredContent); else if (p && p.isError) root.innerHTML='<div class="pad err">'+esc((p.content&&p.content[0]&&p.content[0].text)||"")+'</div>'; else root.innerHTML=''; };
app.onhostcontextchanged = function(ctx){ theme(ctx); if(state) render(state); };
app.connect().then(function(){ theme(app.getHostContext()); }).catch(function(e){ root.innerHTML='<div class="pad muted small">'+esc(e && e.message)+'</div>'; });
})();
`;
