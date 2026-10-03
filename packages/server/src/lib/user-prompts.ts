import { eq } from 'drizzle-orm';
import { familyOf, type UserPrompt } from '@yumina/engine';
import { db, type DrizzleDB } from '../db/index.js';
import { userPrompts, promptFolders } from '../db/schema.js';
import { UNRESTRICT_KIND, getUnrestrictEligibility } from './unrestrict.js';

export interface UserPromptContext {
  /** Model the turn is generated with — selects which per-model-bound prompts apply. */
  modelId?: string | null;
}

type PromptRow = Pick<typeof userPrompts.$inferSelect,
  'id' | 'name' | 'content' | 'section' | 'enabled' | 'depth' | 'position' | 'folderId' | 'kind' | 'apiRole' | 'autoModels'>;
type FolderRow = Pick<typeof promptFolders.$inferSelect, 'id' | 'enabled'>;

/**
 * Pure selection: which of a user's prompts are sent this turn.
 * - A disabled prompt, or one inside a disabled folder, is never sent.
 * - Not eligible ⇒ every kind='unrestrict' row is dropped (the age gate).
 * - Per-model binding: a prompt with no binding (autoModels null/empty) is always-on;
 *   a prompt WITH a binding applies only when familyOf(modelId) ∈ autoModels.
 */
export function selectUserPrompts(
  prompts: PromptRow[],
  folders: FolderRow[],
  eligible: boolean,
  ctx: UserPromptContext = {},
): UserPrompt[] {
  const disabledFolderIds = new Set(folders.filter(f => !f.enabled).map(f => f.id));
  const family = familyOf(ctx.modelId);

  return prompts
    .filter(p => p.enabled && (!p.folderId || !disabledFolderIds.has(p.folderId)))
    .filter(p => eligible || p.kind !== UNRESTRICT_KIND)
    .filter(p => {
      const bound = Array.isArray(p.autoModels) ? p.autoModels : [];
      return bound.length === 0 || bound.includes(family);
    })
    .map(p => ({ id: p.id, name: p.name, content: p.content,
      section: p.section as UserPrompt['section'], enabled: true,
      ...(p.depth != null && { depth: p.depth }),
      ...(p.position != null && { position: p.position }),
      ...(p.apiRole && p.apiRole !== 'system' && { apiRole: p.apiRole }),
    }));
}

/** Shared by regular worlds and native games. A disabled folder disables its prompts. */
export async function loadUserPrompts(
  userId: string,
  ctx: UserPromptContext = {},
  database: DrizzleDB = db,
): Promise<UserPrompt[]> {
  const [prompts, folders, eligibility] = await Promise.all([
    database.select().from(userPrompts).where(eq(userPrompts.userId, userId)),
    database.select({ id: promptFolders.id, enabled: promptFolders.enabled }).from(promptFolders).where(eq(promptFolders.userId, userId)),
    getUnrestrictEligibility(userId, database),
  ]);
  return selectUserPrompts(prompts, folders, eligibility.eligible, ctx);
}
