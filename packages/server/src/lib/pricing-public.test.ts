import assert from "node:assert/strict";
import { test } from "node:test";
import { MUSHIE_PACKS, PLAY_MODELS } from "@yumina/shared";
import { edition } from "../edition/index.js";
import { PUBLIC_ORIGIN } from "./env.js";
import { PLANS } from "./plan-config.js";
import { PLANS_V2 } from "./plan-config-v2.js";
import { renderPublicContent } from "./prerender.js";
import { PRICING_PATH, PRICING_TITLE, dollars, pricingFaq, pricingMeta, publicPlans, renderPricing } from "./pricing-public.js";
import { getMetaForPath, injectMeta } from "./seo.js";

const NO_BILLING = edition.info().features.billing ? false : "this edition has no plans";
const withLaunch = <T>(value: string | undefined, run: () => T): T => {
  const before = process.env.BILLING_V2_LAUNCH_AT;
  if (value === undefined) delete process.env.BILLING_V2_LAUNCH_AT;
  else process.env.BILLING_V2_LAUNCH_AT = value;
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.BILLING_V2_LAUNCH_AT;
    else process.env.BILLING_V2_LAUNCH_AT = before;
  }
};
const now = new Date("2026-11-15T00:00:00Z");

test("every plan's name, price, memory and storage come from the plan table, in order, and the staff plan is not listed", () => {
  const plans = publicPlans(now);
  assert.deepEqual(plans.map((p) => p.id), ["free", "go", "plus", "pro", "ultra"]);
  for (const plan of plans) {
    assert.equal(plan.name, PLANS[plan.id].displayName);
    assert.equal(plan.priceCents, PLANS[plan.id].priceCents);
    assert.equal(plan.memoryTokens, PLANS[plan.id].memoryCap);
    assert.equal(plan.storageBytes, PLANS[plan.id].storageCap);
  }
  assert.equal(plans[0]!.priceCents, 0);
  assert.equal(plans[0]!.memoryTokens, 64_000, "the free memory cap the docs state");
});

test("the month's mushies are the ones a new account gets: the second lineup once it is live, the first before", () => {
  const first = withLaunch(undefined, () => publicPlans(now));
  for (const plan of first) {
    assert.equal(plan.monthlyMushies, PLANS[plan.id].monthlyCredits, plan.id);
    assert.equal(plan.questMushies, 0);
  }
  const second = withLaunch("2026-09-15T00:00:00Z", () => publicPlans(now));
  for (const plan of second) {
    assert.equal(plan.monthlyMushies, PLANS_V2[plan.id].monthlyCredits, plan.id);
    assert.equal(plan.questMushies, PLANS_V2[plan.id].questMonthlyCap, plan.id);
  }
  // A launch date still ahead changes nothing yet.
  const ahead = withLaunch("2027-01-01T00:00:00Z", () => publicPlans(now));
  assert.equal(ahead[1]!.monthlyMushies, PLANS.go.monthlyCredits);
  // The page prints whichever lineup is live.
  const html = withLaunch("2026-09-15T00:00:00Z", () => renderPricing(publicPlans(now)));
  assert.ok(html.includes(`${PLANS_V2.go.monthlyCredits.toLocaleString("en-US")}, plus up to ${PLANS_V2.go.questMonthlyCap.toLocaleString("en-US")} from quests`));
});

test("the models a plan opens are read from the model list", () => {
  const plans = publicPlans(now);
  const tiersOf = (plan: string) => [...new Set(PLAY_MODELS.filter((m) => (m.minPlan ?? "free") === plan).map((m) => m.tier))];
  assert.deepEqual(plans[0]!.tiers, ["budget", "standard"]);
  assert.ok(tiersOf("go").includes("premium") && plans[1]!.adds.some((a) => a.tier === "premium"));
  assert.ok(tiersOf("plus").includes("ultra") && plans[2]!.adds.some((a) => a.tier === "ultra"));
  assert.deepEqual(plans[3]!.adds, [], "Diamond opens no tier Platinum lacks");
  for (const plan of plans) for (const add of plan.adds) for (const name of add.models) assert.ok(PLAY_MODELS.some((m) => m.name === name), name);
});

test("the page shows every plan's price and what it includes, the packs, and the positioning from the docs", () => {
  const plans = publicPlans(now);
  const html = renderPricing(plans);
  assert.match(html, /^<main class="pre pre-pricing"><h1 class="pre-h1">Yumina pricing<\/h1>/);
  for (const plan of plans) {
    // Free leads with what has no limit; every plan still states its mushies.
    const included = plan === plans[0] ? `Unlimited play on the free model; ${plan.monthlyMushies.toLocaleString("en-US")}` : plan.monthlyMushies.toLocaleString("en-US");
    assert.ok(html.includes(`<th scope="row">${plan.name}</th><td>${plan.priceCents ? `${dollars(plan.priceCents)} a month` : "Free"}</td><td>${included}`), plan.name);
  }
  assert.ok(html.includes("<td>64,000 tokens</td>") && html.includes("<td>96,000 tokens</td>") && html.includes("<td>Never trimmed</td>"));
  for (const pack of MUSHIE_PACKS) assert.ok(html.includes(`<tr><td>${pack.mushies.toLocaleString("en-US")}</td><td>${dollars(pack.cents)}</td></tr>`));
  // Playing is free, a free model for every account, a paid plan covers stronger models, no profit from usage, own key has no cap.
  assert.match(html, /Playing, building and publishing on Yumina is free\./);
  assert.match(html, /Every account has a free AI model with no message limit/);
  assert.ok(!/free mushies every month\. Bring/.test(html), "the free offer leads with the model, not a mushie count");
  assert.match(html, /A paid plan covers the cost of running stronger models for you\./);
  assert.match(html, /does not profit from how much you chat/);
  assert.match(html, /memory has no cap on any plan/);
  assert.doesNotMatch(html, /Creator<\/th>|1,000,000/, "the staff plan is not on the page");
  assert.doesNotMatch(html, /—/, "no em dashes");
  assert.equal(dollars(500), "$5");
  assert.equal(dollars(299), "$2.99");
});

test("the questions on the page are the ones in the FAQPage data, word for word", () => {
  const plans = publicPlans(now);
  const faq = pricingFaq(plans);
  assert.ok(faq.length >= 5 && faq.length <= 9, String(faq.length));
  const html = renderPricing(plans);
  const graph = (pricingMeta(plans).jsonLd as { "@graph": Array<Record<string, any>> })["@graph"];
  const page = graph.find((n) => n["@type"] === "FAQPage")!;
  assert.equal(page.mainEntity.length, faq.length);
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const [i, item] of faq.entries()) {
    assert.equal(page.mainEntity[i].name, item.q);
    assert.equal(page.mainEntity[i].acceptedAnswer.text, item.a);
    assert.ok(html.includes(`<dt>${escape(item.q)}</dt><dd>${escape(item.a)}</dd>`), item.q);
  }
  assert.ok(graph.some((n) => n["@type"] === "BreadcrumbList"));
  const offers = graph.find((n) => n["@type"] === "WebPage")!.mainEntity.itemListElement;
  assert.deepEqual(offers.map((o: any) => o.item.price), plans.map((p) => (p.priceCents / 100).toFixed(2)));
});

test("/pricing is an indexable page with its own canonical; /app/plans stays out of search", { skip: NO_BILLING }, async () => {
  const meta = await getMetaForPath(PRICING_PATH);
  assert.equal(meta.status, undefined);
  assert.equal(meta.noindex, undefined);
  assert.equal(meta.title, PRICING_TITLE);
  assert.equal(meta.url, `${PUBLIC_ORIGIN}/pricing`);
  assert.match(meta.description, /^Yumina is free to play/);
  const html = injectMeta(`<html lang="en"><head><title>x</title><link rel="canonical" href="x" />\n</head></html>`, meta);
  assert.match(html, /"@type":"FAQPage"/);
  assert.equal(await renderPublicContent("/pricing"), renderPricing());
  assert.equal(await renderPublicContent("/pricing/"), renderPricing());

  const plansPage = await getMetaForPath("/app/plans");
  assert.equal(plansPage.noindex, true);
  assert.equal(await renderPublicContent("/app/plans"), null);
  assert.equal((await getMetaForPath("/pricing/extra")).status, 404);
});

test("the plans table carries the own-key tier right under Free: free, no cap", () => {
  const html = renderPricing();
  const rows = [...html.matchAll(/<tr><th scope="row">([^<]+)<\/th>(.*?)<\/tr>/g)];
  assert.equal(rows[1]?.[1], "Your own key", "second row, under Free");
  assert.ok(rows[1]![2]!.includes("<td>Free</td>") && rows[1]![2]!.includes("<td>No cap</td>") && rows[1]![2]!.includes("Unlimited play"));
});
