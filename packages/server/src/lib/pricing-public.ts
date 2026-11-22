/**
 * yumina.io/pricing: the plans, as a page anyone can read.
 *
 * The plans page in the app (/app/plans) needs a session and stays out of
 * search, so until this page the site had nothing a search engine could show
 * for "Yumina pricing". Every number here is read from where the app and the
 * billing code read it: names, prices, memory and storage from PLANS
 * (plan-config.ts), the month's mushies from the lineup a new account joins
 * today (plan-config-v2.ts once it is live, the first lineup before that),
 * which models a plan opens from the model list (PLAY_MODELS), and packs from
 * MUSHIE_PACKS. Nothing is typed in twice, so the page cannot drift from what
 * is charged.
 *
 * The words around the numbers follow docs/help/is-yumina-free.md,
 * docs/guide/choosing-an-ai-model.md and docs/vision/index.md.
 */
import { MUSHIE_PACKS, PLAY_MODELS, type CostTier } from "@yumina/shared";
import { PUBLIC_ORIGIN } from "./env.js";
import { PLANS, type PlanId } from "./plan-config.js";
import { isV2Signup, PLANS_V2 } from "./plan-config-v2.js";
import { breadcrumbLd, esc, faqHtml, faqLd, type Faq } from "./public-page-parts.js";

export const PRICING_PATH = "/pricing";
export const PRICING_TITLE = "Yumina Pricing: Free to Play, Plans From $5 a Month";

/** The plans a person can choose, cheapest first. */
export const PUBLIC_PLAN_IDS: readonly PlanId[] = ["free", "go", "plus", "pro", "ultra"];
const LADDER: readonly PlanId[] = ["free", "go", "plus", "pro", "ultra"];
const TIER_ORDER: readonly CostTier[] = ["budget", "standard", "premium", "ultra"];
const TIER_NAMES: Record<CostTier, string> = { budget: "Budget", standard: "Standard", premium: "Premium", ultra: "Ultra" };
const GB = 1024 * 1024 * 1024;

export interface PublicPlan {
  id: PlanId;
  name: string;
  priceCents: number;
  /** Mushies a month on the lineup a new account joins today. */
  monthlyMushies: number;
  /** The most the quest board can add in a month; 0 when the lineup has no board. */
  questMushies: number;
  /** World-side memory in tokens; null when it is never trimmed. */
  memoryTokens: number | null;
  storageBytes: number;
  /** Extra mushies on a pack, as a percentage. */
  packBonusPct: number;
  /** Model tiers this plan can pick, cheapest first. */
  tiers: CostTier[];
  /** The tiers this plan adds over the one below it, each with a few model names. */
  adds: Array<{ tier: CostTier; models: string[] }>;
}

function tiersFor(plan: PlanId): CostTier[] {
  const rank = LADDER.indexOf(plan);
  const open = new Set<CostTier>();
  for (const model of PLAY_MODELS) {
    if (model.tier && LADDER.indexOf((model.minPlan ?? "free") as PlanId) <= rank) open.add(model.tier);
  }
  return TIER_ORDER.filter((tier) => open.has(tier));
}

/** The plans as the page shows them. `now` picks the lineup a new signup gets at that moment. */
export function publicPlans(now: Date = new Date()): PublicPlan[] {
  const v2 = isV2Signup(now);
  return PUBLIC_PLAN_IDS.map((id, index) => {
    const plan = PLANS[id];
    const tiers = tiersFor(id);
    const below = index > 0 ? new Set(tiersFor(PUBLIC_PLAN_IDS[index - 1]!)) : new Set<CostTier>();
    return {
      id,
      name: plan.displayName,
      priceCents: plan.priceCents,
      monthlyMushies: v2 ? PLANS_V2[id].monthlyCredits : plan.monthlyCredits,
      questMushies: v2 ? PLANS_V2[id].questMonthlyCap : 0,
      memoryTokens: plan.memoryCap,
      storageBytes: plan.storageCap,
      packBonusPct: v2 ? PLANS_V2[id].packBonusPct : 0,
      tiers,
      adds: tiers
        .filter((tier) => !below.has(tier))
        .map((tier) => ({
          tier,
          models: PLAY_MODELS.filter((m) => m.tier === tier && LADDER.indexOf((m.minPlan ?? "free") as PlanId) <= index).slice(0, 4).map((m) => m.name),
        })),
    };
  });
}

const count = (n: number) => n.toLocaleString("en-US");
export const dollars = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);
const memoryText = (tokens: number | null) => (tokens === null ? "Never trimmed" : `${count(tokens)} tokens`);
const storageText = (bytes: number) => `${Math.round(bytes / GB)} GB`;
const priceText = (plan: PublicPlan) => (plan.priceCents === 0 ? "Free" : `${dollars(plan.priceCents)} a month`);

/** The questions on the page, answered from the plans and the help pages. */
export function pricingFaq(plans: PublicPlan[]): Faq[] {
  const free = plans[0]!;
  const gold = plans[1]!;
  const firstUntrimmed = plans.find((p) => p.memoryTokens === null);
  const premium = plans.find((p) => p.adds.some((a) => a.tier === "premium"));
  const ultra = plans.find((p) => p.adds.some((a) => a.tier === "ultra"));
  const smallest = MUSHIE_PACKS[0];
  return [
    {
      q: "Is Yumina free?",
      a: "Yes. You can play, build and publish without paying. Yumina Free has no message limit and never costs mushies. With your own key, every model your provider offers is free on Yumina's side too. Every account also gets free mushies each month to try stronger models.",
    },
    {
      q: "Is there a message limit on the free model?",
      a: "No. Yumina Free sends each turn to one of a pool of free models, and a turn on it costs no mushies however much you play. An empty wallet never stops it. When that pool is full, Yumina moves a text turn to another model and pays for it.",
    },
    {
      q: "What does a paid plan pay for?",
      a:
        `A paid plan covers the cost of running stronger models for you, with more playing time.${premium && ultra ? " " : ""}` +
        (premium && ultra ? `${premium.name} opens the Premium models and ${ultra.name} opens the Ultra models.` : ""),
    },
    {
      q: "What are mushies?",
      a: "Mushies are what a reply from a model costs. Stronger models cost more mushies per reply, and the model picker shows the current price of each one. The free model costs none.",
    },
    {
      q: "Can I use my own API key?",
      a: "Yes. Paste a key from OpenRouter, Anthropic, OpenAI, Google or any OpenAI-compatible service under Settings > AI Config. You pay the provider directly, no mushies are spent, and memory has no cap on any plan. Yumina also plays on a model running on your own computer.",
    },
    {
      q: "How much of my story does the AI remember on each plan?",
      a:
        `The AI re-reads the world and your conversation on every turn. On ${free.name} the world side is capped at ${memoryText(free.memoryTokens)}` +
        (gold.memoryTokens !== null ? `, on ${gold.name} at ${memoryText(gold.memoryTokens)}` : "") +
        (firstUntrimmed ? `, and from ${firstUntrimmed.name} up it is never trimmed` : "") +
        `. With your own key there is no cap. Older scenes are folded into a recap, so the AI keeps the events after it loses the exact words.`,
    },
    {
      q: "Does Yumina make money from how much I chat?",
      a: "No. Yumina is open source and does not profit from AI usage. A platform that earns on every message is pushed toward worse models, shorter memory and selling data, which is why you can bring your own key and pay the provider yourself.",
    },
    ...(smallest
      ? [{
          q: "Can I buy mushies without a plan?",
          a: `Yes. Packs start at ${count(smallest.mushies)} mushies for ${dollars(smallest.cents)} and go up to ${count(MUSHIE_PACKS.at(-1)!.mushies)} for ${dollars(MUSHIE_PACKS.at(-1)!.cents)}.`,
        }]
      : []),
    {
      q: "How do I cancel or get a refund?",
      a: "Cancel from the Plans page with Cancel Subscription. You keep the plan until the end of the period you paid for, then the account goes back to Free. For a refund, email support@yumina.io within 7 days of the payment.",
    },
  ];
}

/** The #root fragment for /pricing. */
export function renderPricing(plans: PublicPlan[] = publicPlans()): string {
  const free = plans[0]!;
  const rows = plans
    .map((plan) => {
      const models = plan.tiers.map((t) => TIER_NAMES[t]).join(", ");
      const amount = `${count(plan.monthlyMushies)}${plan.questMushies ? `, plus up to ${count(plan.questMushies)} from quests` : ""}`;
      // Free leads with what has no limit; its mushies are only for trying stronger models.
      const mushies = plan === free ? `Unlimited play on the free model; ${amount} mushies for stronger models` : `${amount} mushies`;
      return `<tr><th scope="row">${esc(plan.name)}</th><td>${esc(priceText(plan))}</td><td>${esc(mushies)}</td><td>${esc(models)}</td><td>${esc(memoryText(plan.memoryTokens))}</td><td>${esc(storageText(plan.storageBytes))}</td></tr>`;
    });
  // Your own key is a tier of its own: free on Yumina's side and uncapped. It
  // sits right under Free so nobody reads the table without seeing it.
  rows.splice(
    1,
    0,
    `<tr><th scope="row">Your own key</th><td>Free</td><td>Unlimited play; no mushies needed</td><td>Every model your provider offers</td><td>No cap</td><td>Same as your plan</td></tr>`,
  );
  const adds = plans
    .filter((plan) => plan.adds.length)
    .map((plan) => {
      const what = plan.adds.map((a) => `${TIER_NAMES[a.tier]} models such as ${a.models.join(", ")}`).join("; ");
      return `<li><strong>${esc(plan.name)}</strong>: ${esc(what)}.</li>`;
    })
    .join("");
  const packs = MUSHIE_PACKS.length
    ? `<section class="pre-more"><h2 class="pre-h2">Mushie packs</h2><div class="pre-text"><p>A pack is a one-time top-up for any account, with or without a plan.</p></div>` +
      `<table class="pre-table"><thead><tr><th scope="col">Mushies</th><th scope="col">Price</th></tr></thead><tbody>` +
      MUSHIE_PACKS.map((p) => `<tr><td>${count(p.mushies)}</td><td>${esc(dollars(p.cents))}</td></tr>`).join("") +
      `</tbody></table></section>`
    : "";
  return (
    `<main class="pre pre-pricing"><h1 class="pre-h1">Yumina pricing</h1>` +
    `<div class="pre-text"><p>Playing, building and publishing on Yumina is free. Every account has a free AI model with no message limit, and it never costs mushies. Bring your own key and every other model is free on Yumina's side too: you pay the provider directly, and Yumina adds nothing. A paid plan covers the cost of running stronger models for you. Yumina does not profit from how much you chat.</p></div>` +
    `<section class="pre-more"><h2 class="pre-h2">Plans</h2>` +
    `<table class="pre-table"><thead><tr><th scope="col">Plan</th><th scope="col">Price</th><th scope="col">Included each month</th><th scope="col">Models</th><th scope="col">Memory cap</th><th scope="col">Storage</th></tr></thead><tbody>${rows.join("")}</tbody></table>` +
    `<div class="pre-text"><p>Mushies pay for replies from models that cost money to run. The memory cap is how much of the world the AI can read on each turn. With your own key there is no cap.</p></div></section>` +
    (adds ? `<section class="pre-more"><h2 class="pre-h2">Which models each plan opens</h2><ul class="pre-list">${adds}</ul></section>` : "") +
    packs +
    `<section class="pre-more"><h2 class="pre-h2">Your own key</h2><div class="pre-text"><p>You can paste a key from OpenRouter, Anthropic, OpenAI, Google or any OpenAI-compatible service and pay that provider directly. No mushies are spent, you get every model they offer, and memory has no cap on any plan. Yumina also plays on a model running on your own computer through Ollama, LM Studio, Jan or llama.cpp.</p></div></section>` +
    `<section class="pre-more"><h2 class="pre-h2">Questions</h2>${faqHtml(pricingFaq(plans))}</section>` +
    `<p class="pre-by"><a href="/register">Create an account</a> · <a href="/blog">Blog</a> · <a href="/updates">Updates</a></p></main>`
  );
}

/** Title, description and structured data for /pricing. */
export function pricingMeta(plans: PublicPlan[] = publicPlans()) {
  const url = `${PUBLIC_ORIGIN}${PRICING_PATH}`;
  const paid = plans.filter((p) => p.priceCents > 0);
  const description =
    `Yumina is free to play: a free AI model with no message limit, or your own key with no limits at all. ` +
    `Paid plans run ${dollars(paid[0]!.priceCents)} to ${dollars(paid.at(-1)!.priceCents)} a month and cover the cost of stronger models.`;
  return {
    title: PRICING_TITLE,
    description,
    url,
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": url,
          url,
          name: PRICING_TITLE,
          description,
          isPartOf: { "@type": "WebSite", name: "Yumina", url: PUBLIC_ORIGIN },
          mainEntity: {
            "@type": "ItemList",
            itemListElement: plans.map((plan, i) => ({
              "@type": "ListItem",
              position: i + 1,
              item: {
                "@type": "Offer",
                name: `Yumina ${plan.name}`,
                price: (plan.priceCents / 100).toFixed(2),
                priceCurrency: "USD",
                url,
                description: `${count(plan.monthlyMushies)} mushies a month, ${plan.tiers.map((t) => TIER_NAMES[t]).join(", ")} models, memory cap ${memoryText(plan.memoryTokens).toLowerCase()}, ${storageText(plan.storageBytes)} storage.`,
              },
            })),
          },
        },
        breadcrumbLd([{ name: "Yumina", path: "/" }, { name: "Pricing", path: PRICING_PATH }]),
        faqLd(pricingFaq(plans)),
      ],
    },
  };
}
