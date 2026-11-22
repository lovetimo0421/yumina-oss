/**
 * Whether a message is the 「整张卡帮你写好」 request with the creator's idea
 * written after it: the suggestion's own words, then something of theirs.
 * The words alone (sent before an idea was added) are not the request — the
 * assistant should ask for the idea, not invent one.
 */
export function wholeCardRequest(message: string, fill: string): boolean {
  const lead = fill.trim().replace(/[:：]\s*$/, "");
  const text = message.trim();
  if (!lead || !text.startsWith(lead)) return false;
  const idea = text.slice(lead.length).replace(/^[\s:：]+/, "");
  return idea.length >= 2;
}
