/**
 * Open-source edition stub. Measured per-reply model costs come from the
 * hosted platform's usage ledger; a local install has no such ledger, so the
 * model picker simply shows no cost range.
 */
import type { ModelCostStats } from "@yumina/shared";

export async function getModelCostStats(): Promise<Map<string, ModelCostStats>> {
  return new Map();
}
