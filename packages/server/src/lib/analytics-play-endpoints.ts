/** Reporting classification only: billing and reward qualification have their
 * own policies. A side completion is narrative play even when an NPC initiates
 * it; side decisions, memory and other support calls are still usage, not an
 * additional play interaction. Success is recorded by the endpoint name. */
export const NARRATIVE_PLAY_ENDPOINTS_SQL = "'send','regenerate','continue','side-completion'";
export const PLAY_ENDPOINTS_SQL = `${NARRATIVE_PLAY_ENDPOINTS_SQL},'pvz-dave'`;

/** Failed/empty attempts contribute to the cost of play, not its message count. */
export const PLAY_COST_ENDPOINTS_SQL = `${PLAY_ENDPOINTS_SQL},'send_empty','regenerate_empty','continue_empty','send_repetitive','regenerate_repetitive','continue_repetitive','pvz-dave-unheard','side-completion_empty'`;
