/**
 * The "Allow direct messages" privacy setting gates unsolicited inbound
 * messages, not active conversations. Once the recipient has sent a message
 * in the thread themselves — they initiated it, or they replied — the other
 * side may keep responding even if the recipient later turns DMs off.
 * Blocking is the tool that closes an active thread.
 *
 * Both the send endpoint and the conversation payload's canSend computation
 * must agree on this rule; they both call this function.
 */
export function dmDeliveryAllowed(opts: {
  recipientAllowsDMs: boolean;
  recipientHasMessaged: boolean;
}): boolean {
  return opts.recipientAllowsDMs || opts.recipientHasMessaged;
}
