import { z } from "zod";

export const MAX_PERSONA_ENTRIES = 20;
export const MAX_PERSONA_ENTRY_TITLE = 100;
export const MAX_PERSONA_ENTRY_CONTENT = 5000;
export const MAX_PERSONA_ENTRIES_TOTAL = 20000;

export const personaEntriesSchema = z.array(z.object({
  title: z.string().trim().min(1).max(MAX_PERSONA_ENTRY_TITLE),
  content: z.string().trim().min(1).max(MAX_PERSONA_ENTRY_CONTENT),
})).max(MAX_PERSONA_ENTRIES).refine(
  entries => entries.reduce((total, entry) => total + entry.title.length + entry.content.length, 0) <= MAX_PERSONA_ENTRIES_TOTAL,
  { message: `Custom entries must total ${MAX_PERSONA_ENTRIES_TOTAL} characters or fewer` },
);

export type PersonaEntry = z.infer<typeof personaEntriesSchema>[number];

export function formatPersonaEntries(entries?: readonly PersonaEntry[] | null): string {
  return (entries ?? []).map(entry => `${entry.title}: ${entry.content}`).join("\n\n");
}
