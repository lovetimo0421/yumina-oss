import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAtelier } from "./atelier-public.js";
import { asksForMarkdown, fragmentToMarkdown, markdownSourcePath, markdownTwinPath, pageMarkdown } from "./page-markdown.js";
import { pricingMeta, renderPricing } from "./pricing-public.js";

const SITE = "https://example.test";

test("headings, paragraphs and inline marks come through; site links become absolute", () => {
  const md = fragmentToMarkdown(
    `<main class="pre"><h1 class="pre-h1">Title &amp; more</h1><div class="pre-text"><p>One <strong>bold</strong> and a <a href="/pricing">link</a>.</p><p>Two<br>lines.</p></div><section><h2>Part</h2><p><a href="https://other.test/x">out</a> <a href="#part">here</a></p></section></main>`,
    SITE,
  );
  assert.equal(md, `# Title & more\n\nOne **bold** and a [link](${SITE}/pricing).\n\nTwo\nlines.\n\n## Part\n\n[out](https://other.test/x) [here](#part)\n`);
});

test("a table becomes a pipe table with one rule under the header; pipes in cells are escaped", () => {
  const md = fragmentToMarkdown(
    `<table><thead><tr><th scope="col">Plan</th><th scope="col">Price</th></tr></thead><tbody><tr><th scope="row">Free</th><td>$0</td></tr><tr><th scope="row">A | B</th><td>$5 a month</td></tr></tbody></table>`,
    SITE,
  );
  assert.equal(md, "| Plan | Price |\n| --- | --- |\n| Free | $0 |\n| A \\| B | $5 a month |\n");
});

test("lists keep their order and numbering; a question list keeps each question with its answer", () => {
  const md = fragmentToMarkdown(`<ol><li>First</li><li>Second <a href="/a">a</a></li></ol><ul><li>Dot</li></ul><dl><dt>Is it free?</dt><dd>Yes.</dd><dt>Really?</dt><dd>Yes, really.</dd></dl>`, SITE);
  assert.equal(md, `1. First\n2. Second [a](${SITE}/a)\n\n- Dot\n\n**Is it free?**\n\nYes.\n\n**Really?**\n\nYes, really.\n`);
});

test("a grid of cards reads as a list of names, covers without alt text are dropped", () => {
  const card = (href: string, name: string, by: string) => `<a class="pre-card" href="${href}"><img class="pre-card__img" src="/c.png" alt="" /><span class="pre-card__name">${name}</span><span class="pre-card__by">${by}</span></a>`;
  const md = fragmentToMarkdown(`<div class="pre-grid">${card("/@a/one-1", "One", "Ann")}${card("/@b/two-2", "Two [beta]", "Bo")}</div>`, SITE);
  assert.equal(md, `- [One · Ann](${SITE}/@a/one-1)\n- [Two \\[beta\\] · Bo](${SITE}/@b/two-2)\n`);
});

test("scripts and styles never reach the copy; user text cannot open a tag or break out of a link", () => {
  const md = fragmentToMarkdown(`<p>Hi<script>alert(1)</script><style>p{}</style> there &lt;b&gt;x&lt;/b&gt; *star* \`tick\`</p><img src="/p.png" alt="A cat">`, SITE);
  assert.ok(!md.includes("alert"), "no script text");
  assert.ok(!md.includes("p{}"), "no style text");
  assert.ok(md.includes("&lt;b>x&lt;/b>"), `tags in user text stay text: ${md}`);
  assert.ok(md.includes("\\*star\\*") && md.includes("\\`tick\\`"), "markup characters are escaped");
  assert.ok(md.includes(`![A cat](${SITE}/p.png)`), "a picture with alt text is kept");
});

test("the copy carries front matter a machine can read, then the page's own words", () => {
  const md = pageMarkdown({ title: 'Say "hi"', description: "Two\nlines", url: `${SITE}/x`, lang: "en" }, "<h1>Hello</h1><p>Words.</p>", SITE);
  assert.equal(md, `---\ntitle: "Say \\"hi\\""\ndescription: "Two lines"\nurl: ${SITE}/x\nlang: en\n---\n\n# Hello\n\nWords.\n`);
});

test("the pricing page's copy has the plans table with the own-key tier, the packs and the questions", () => {
  const md = pageMarkdown(pricingMeta(), renderPricing());
  assert.match(md, /^---\ntitle: "/);
  assert.match(md, /\n# Yumina pricing\n/);
  assert.match(md, /\n\| Plan \| Price \| Included each month \| Models \| Memory cap \| Storage \|\n\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| Free \| Free \| Unlimited play on the free model; /);
  assert.match(md, /\n\| Your own key \| Free \| Unlimited play; no mushies needed \| Every model your provider offers \| No cap \| Same as your plan \|\n/);
  assert.match(md, /\n\*\*Is Yumina free\?\*\*\n\nYes\./);
  assert.ok(!/<\/?[a-z][^>\n]*>/i.test(md), "no HTML left in the copy");
});

test("the Atelier page's copy lists what you can make and links every model page by its full address", () => {
  const md = fragmentToMarkdown(renderAtelier());
  assert.match(md, /^# Atelier/);
  assert.match(md, /\n## What you can make\n/);
  const links = [...md.matchAll(/\]\((https?:\/\/[^)\s]+\/atelier\/(?:image|video|styles)\/[a-z0-9-]+)\)/g)];
  assert.ok(links.length >= 20, `${links.length} model and style links`);
  assert.ok(!/\]\(\//.test(md), "no site-relative links");
  assert.ok(!/<\/?[a-z][^>\n]*>/i.test(md), "no HTML left in the copy");
});

test("a page and its copy find each other by address; only a real .md address is a copy", () => {
  assert.equal(markdownSourcePath("/pricing.md"), "/pricing");
  assert.equal(markdownSourcePath("/index.md"), "/");
  assert.equal(markdownSourcePath("/@ann/world-1a2b.md"), "/@ann/world-1a2b");
  assert.equal(markdownSourcePath("/pricing"), null);
  assert.equal(markdownSourcePath("/.md"), null);
  assert.equal(markdownSourcePath("/a/.md"), null);
  assert.equal(markdownTwinPath("/pricing"), "/pricing.md");
  assert.equal(markdownTwinPath("/pricing/"), "/pricing.md");
  assert.equal(markdownTwinPath("/"), "/index.md");
  for (const path of ["/", "/pricing", "/atelier/video/kling", "/@ann/world-1a2b"]) assert.equal(markdownSourcePath(markdownTwinPath(path)), path);
});

test("Markdown is served on the page's own address only when it is asked for ahead of HTML", () => {
  assert.equal(asksForMarkdown("text/markdown"), true);
  assert.equal(asksForMarkdown("text/markdown, text/html;q=0.9"), true);
  assert.equal(asksForMarkdown("text/html,application/xhtml+xml,*/*;q=0.8"), false);
  assert.equal(asksForMarkdown("text/html, text/markdown"), false);
  assert.equal(asksForMarkdown(undefined), false);
});
