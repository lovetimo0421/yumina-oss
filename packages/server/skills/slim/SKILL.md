---
name: slim
description: Diagnose and fix bloated lorebooks — oversized always-send load, mega-entries, keyword spam, duplicated content, contradictory entries. Use when the creator asks to 精简/整理/去冗余/optimize the lorebook or complains about token cost, OR when this skill was auto-loaded because the world exceeds lorebook health budgets. Diagnosis-first: never delete or rewrite existing content without the creator's explicit approval.
---

# Skill: Lorebook Slimming

Fix an already-bloated lorebook. This is REMEDIATION — different from writing good new entries (prevention). The core loop: measure → diagnose → propose → get approval → execute in batches → re-measure.

## The Iron Rule: Consent Before Cuts

You may freely REPORT what is redundant, oversized, or deletable. You may NOT delete, merge, trim, or rewrite existing content until the creator has seen your findings list and explicitly approved. This includes:

- `delete_entities` on any existing entry — always list what would be deleted and why, then wait for approval.
- Rewriting an entry to a shorter version — show what would be cut (categories + examples, not necessarily full text), then wait.
- Merging two entries — name both, say what survives, then wait.

Heavy always-send load is sometimes intentional. If the creator says "I want it this way", accept it, stop flagging it for the rest of the conversation, and do not bring it up again.

Adding NEW entries (e.g. split children, an index entry) alongside untouched originals still changes what the gameplay AI reads — treat splits as part of the approved plan, not as a loophole.

## Step 1 — Measure

Call `analyze_token_cost()` first. Do not diagnose from impressions; get the numbers: always-send total, keyword-pool worst case, per-entry sizes. If a health report was injected into your context (`<lorebook-health>`), it already contains the top offenders — start from it.

## Step 2 — Diagnose (what counts as bloat)

Check in this order — highest savings first:

1. **Mega-entries** — one entry holding a whole cast/faction/timeline (>3,000 tokens or >10 keywords pointing at different people). One keyword match injects ALL of it.
2. **Pseudo-always entries** — keyword lists so broad they fire every turn (≥15 keywords, or common words like 身体/呼吸/夜里, generic genre words). Effectively always-send without being labeled as such.
3. **Duplicated content** — the same facts/quotes/rules written in two entries (a character's quotes in both their profile AND a quote library; the same style rule stated in three rule entries). One fact, one home.
4. **Contradictions** — two entries giving the gameplay AI incompatible instructions (e.g. one bans explicit vocabulary, another mandates it). These aren't just bloat — they actively degrade output. Creator must pick one.
5. **Oversized always-send** — rule/style entries that repeat the same principle in different words; profiles padded with content that never changes any line the AI writes.

## Step 3 — Propose (the findings list)

Present a numbered findings list to the creator: what, where, size, why it costs, and the proposed fix for each. Give the projected per-turn total after the plan. Keep it compact — a table or short list, not an essay. Then ask which items to proceed with (use `ask_user` if you need a decision to continue).

## Step 4 — Execute (only approved items, in batches)

Proven fix patterns:

- **Split by person**: a cast mega-entry becomes one entry per character; each child's `keywords` = ONLY that character's names/aliases. Mentioned character loads; nobody else does.
- **Index entry for generic terms**: after splitting, generic collective terms (faction name, group name) point to a small index entry (~150-200 tokens) listing members — not to any full profile.
- **Gate by state**: era/route/phase-specific entries get `conditions` on an existing variable (the same pattern as time-slice entries) so off-era content never loads. Remember `alwaysSend: true` bypasses conditions — turn it off for gated entries.
- **Tighten keywords**: 2-4 specific nouns/names per entry. Kill common-word triggers; use `secondaryKeywords` to gate any broad word that must stay.
- **Merge duplicates**: pick the canonical home (the one with usage rules or better structure), fold unique details into it, delete the copy — with approval.
- **Budget backstop**: suggest `lorebookBudgetCap` (~20,000) via `update_settings` as a safety ceiling. It does not cap always-send — content fixes above are still the main course.

Batch writes ~5 per reply (per the standard large-operation rule), `validate_world` after each phase.

## Step 5 — Re-measure and report

Call `analyze_token_cost()` again. Report before → after (always-send per turn, worst-case pool). If still over budget, say what the next-biggest lever is and stop — don't loop without being asked.

## Etiquette when auto-loaded

If this skill arrived via a health-budget trigger (not the creator asking), mention the situation ONCE, briefly, at a natural moment — one sentence with the headline number and an offer to run a slimming pass. Do not derail the creator's current request. If declined or ignored, don't raise it again in this conversation.
