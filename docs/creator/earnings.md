---
title: "Earnings and payouts"
description: "The Creator Dashboard shows how your worlds do and pays out money tips. You keep 80%, each tip is held 7 days, payouts start at $10 through Stripe, or spend tips on mushies with 5% extra."
---

# Earnings and payouts

The Creator Dashboard, under **Me → Creator Center**, shows how your worlds are doing and pays out the money tips players send you. Mushie gifts go straight into your wallet.

## What the numbers mean

The dashboard compares the last 7 days with the 7 before, never calendar weeks, and never counts your own plays on your own cards.

Pick a card to see its funnel. Each rate is shown against the site average: green above it, yellow slightly below, red well below.

| Rate | How it is counted |
|---|---|
| Click rate | Discover clicks ÷ Discover impressions. An impression counts only when the card was at least half visible for half a second |
| Conversion | Plays started from Discover ÷ Discover clicks |
| Quality rate | Share of all plays that lasted 5 minutes or more |
| Return rate | Share of last week's players who came back this week. Continuing an old save counts |

"Not enough data" means the card has not reached the minimum yet: 200 impressions for click rate, 20 clicks for conversion, 20 plays for quality, 30 players last week for return rate.

The **To do** cards at the top appear when something needs you: a click rate below three quarters of the site average with 200 or more impressions, a jump of 20 or more new players that is also 30% up on last week, or edits that have sat unpublished for 3 days.

## Getting paid

Money tips are split 80/20. You keep 80%, Yumina keeps 20%, and Stripe takes its processing fee on top. Each tip is held for 7 days, the refund window, then becomes available.

To receive money, click **Set Up Payouts** and pick the country you live in. Stripe pays out to the US, UK, EU and EEA, Canada and Switzerland, and the country cannot be changed once the account is active. Stripe checks your identity and bank details. Once it approves, your available balance is paid out automatically whenever it reaches $10. Tax forms come from your Stripe dashboard once you cross your country's reporting threshold, and Yumina produces no separate tax documents.

Anywhere else, or if you would rather not set up payouts, **Spend on mushies** turns tip earnings into mushie packs with 5% extra, from 50 cents up. Only earnings past the 7-day hold can be spent, and what you spend is no longer paid out.

Mushie gifts carry no fee and no hold. Players can gift you mushies once your worlds together have 10 downloads and 100 messages. Money tips have no threshold.

## Worlds that cover the screen

The play header has the heart button players use to support you. A world with a fullscreen interface covers that header, so unless the world offers its own way in, players cannot tip you at all. Have your interface call `api.openSupport()` from somewhere calm, like a corner of the title or pause screen. It opens the same dialog, credited to this world, and you never handle payments yourself. Keep it small. A support prompt shown mid-scene, or right after a player loses, converts worse than one sitting quietly on a menu. Details in the [API reference](./advanced/08-api-reference).

## Related

- [Publishing](./publishing.md)
- [Supporting creators](../guide/supporting-creators.md), what your supporters see
