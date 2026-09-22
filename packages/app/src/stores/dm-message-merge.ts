interface MergeableConversationMessage {
  id: string;
  clientId?: string | null;
  createdAt: string;
  editedAt?: string | null;
  status?: string;
}

/** Merge overlapping pages without duplicate React/virtualizer message keys. */
export function mergeFetchedConversationMessages<T extends MergeableConversationMessage>(
  fetched: T[],
  current: T[],
): T[] {
  const merged = [...fetched];
  for (const message of current) {
    const index = merged.findIndex((candidate) => (
      candidate.id === message.id
      || (message.clientId && candidate.clientId === message.clientId)
    ));
    if (index === -1) {
      merged.push(message);
    } else if (
      message.status === "sent"
      && message.editedAt
      && Date.parse(message.editedAt) > (Date.parse(merged[index].editedAt ?? "") || 0)
    ) {
      // A real-time edit can be newer than the overlapping server snapshot.
      merged[index] = { ...merged[index], ...message, status: "sent" };
    }
  }
  return merged.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}
