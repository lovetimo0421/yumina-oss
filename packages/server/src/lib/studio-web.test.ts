import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText, isPublicAddress, webPageAllowed, webUrlProblem } from "./studio-web-fetch.js";
import { hitsFromAnnotations, webSearchCredits, webSearchResult } from "./studio-web-search.js";
import { READ_TOOL_NAMES, STUDIO_TOOLS, WEB_TOOL_NAMES } from "./studio-tools/tools.js";
import { ADVISOR_READ_TOOLS } from "./studio-advisor.js";

test("only public addresses are reachable", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  // Node's BlockList matches IPv4 against a ::ffff:0:0/96 rule, which once
  // blocked every IPv4 site; public IPv4 and IPv6 must stay reachable.
  for (const ip of ["104.21.41.121", "8.8.8.8", "2606:4700:3031::ac43:a4c2", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("addresses that can never be read are refused before any request", () => {
  assert.equal(webUrlProblem("https://zh.moegirl.org.cn/%E8%8A%99%E8%8E%89%E8%8E%B2"), null);
  assert.equal(webUrlProblem("http://example.com/a?b=1"), null);
  for (const bad of ["file:///etc/passwd", "ftp://example.com/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data/", "http://example.com:8080/", "http://user:pw@example.com/", "http://intranet/", "http://db.internal/", "not a url"]) {
    assert.ok(webUrlProblem(bad), bad);
  }
});

test("a page may be read only when its address is already in the conversation", () => {
  const convo = '{"results":[{"url":"https://zh.moegirl.org.cn/%E8%8A%99%E8%8E%89%E8%8E%B2","title":"芙莉莲"}]}\n看看 https://frieren.fandom.com/wiki/Frieren 这页';
  assert.equal(webPageAllowed("https://zh.moegirl.org.cn/%E8%8A%99%E8%8E%89%E8%8E%B2", convo), true);
  assert.equal(webPageAllowed("https://zh.moegirl.org.cn/芙莉莲", convo), true, "decoded form of a listed address");
  assert.equal(webPageAllowed("https://frieren.fandom.com/wiki/Frieren#History", convo), true, "fragment ignored");
  assert.equal(webPageAllowed("https://evil.example/?card=secret", convo), false);
  assert.equal(webPageAllowed("https://frieren.fandom.com/wiki/Himmel", convo), false, "same site, other page");
});

test("page text keeps the article: wiki body inside <template>, headings, lists, tables; drops scripts and edit links", () => {
  const html = `<!doctype html><html><head><title>芙莉莲 - 萌娘百科</title><script>var x = "ignore me";</script></head><body>
    <nav>导航 菜单</nav>
    <template id="SKIN"><div id="mw-content-text"><div class="mw-parser-output">
      <h2>基本资料<span class="mw-editsection"><span class="mw-editsection-bracket">[</span><a href="?action=edit">编辑</a><span>]</span></span></h2>
      <table><tr><th>本名</th><td>フリーレン</td></tr><tr><th>身高</th><td>150cm</td></tr></table>
      <p>魔法使&nbsp;&amp; 精灵<sup class="reference"><a href="#cite-1">[1]</a></sup>。</p>
      <ul><li>辛美尔</li><li><a href="/%E8%BE%9B%E7%BE%8E%E5%B0%94">辛美尔条目</a></li></ul>
    </div></div></template>
    <div class="printfooter">来自萌娘百科</div><footer>版权</footer></body></html>`;
  const page = htmlToText(html, "https://zh.moegirl.org.cn/%E8%8A%99%E8%8E%89%E8%8E%B2");
  assert.equal(page.title, "芙莉莲 - 萌娘百科");
  assert.match(page.text, /### 基本资料/);
  assert.match(page.text, /本名 \| フリーレン/);
  assert.match(page.text, /身高 \| 150cm/);
  assert.match(page.text, /魔法使 & 精灵。/);
  assert.match(page.text, /- 辛美尔/);
  assert.doesNotMatch(page.text, /ignore me|导航|版权|来自萌娘百科|编辑|\[1\]/);
  assert.deepEqual(page.links.map(l => l.url), ["https://zh.moegirl.org.cn/%E8%BE%9B%E7%BE%8E%E5%B0%94"]);
});

test("search results come from the annotations, deduplicated, with short excerpts", () => {
  const hits = hitsFromAnnotations([
    { type: "url_citation", url_citation: { url: "https://a.example/1", title: " A ", content: "x ".repeat(1000) } },
    { type: "url_citation", url_citation: { url: "https://a.example/1", title: "dup" } },
    { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "bad" } },
    { type: "url_citation", url_citation: { url: "https://b.example/2" } },
    null,
  ]);
  assert.deepEqual(hits.map(h => h.url), ["https://a.example/1", "https://b.example/2"]);
  assert.equal(hits[0]!.title, "A");
  assert.ok(hits[0]!.excerpt.length <= 700);
  assert.deepEqual(hitsFromAnnotations(undefined), []);
  const shown = webSearchResult("q", { results: hits, costUsd: 0.007 });
  assert.match(String(shown.note), /instructions/);
  assert.match(String(webSearchResult("q", { results: [], costUsd: 0 }).note), /Nothing found/);
});

test("a search is billed from the reported cost at the given markup", () => {
  assert.equal(webSearchCredits(0.0073, 1.1), 8.1);
  assert.equal(webSearchCredits(0, 1.1), 0);
});

test("the web tools auto-execute and the advisor has them too", () => {
  for (const name of WEB_TOOL_NAMES) {
    assert.ok(STUDIO_TOOLS.some(t => t.function.name === name), name);
    assert.ok(READ_TOOL_NAMES.has(name), `${name} auto-executes`);
    assert.ok((ADVISOR_READ_TOOLS as readonly string[]).includes(name), `${name} in 构思`);
  }
});
