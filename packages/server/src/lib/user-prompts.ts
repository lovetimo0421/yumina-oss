import { eq } from 'drizzle-orm';
import type { UserPrompt } from '@yumina/engine';
import { db, type DrizzleDB } from '../db/index.js';
import { userPrompts, promptFolders } from '../db/schema.js';

/** Shared by regular worlds and native games. A disabled folder disables its prompts. */
export async function loadUserPrompts(userId: string, database: DrizzleDB = db): Promise<UserPrompt[]> {
  const [prompts, folders] = await Promise.all([
    database.select().from(userPrompts).where(eq(userPrompts.userId, userId)),
    database.select().from(promptFolders).where(eq(promptFolders.userId, userId)),
  ]);
  const disabledFolderIds = new Set(folders.filter(f => !f.enabled).map(f => f.id));
  return prompts
    .filter(p => p.enabled && (!p.folderId || !disabledFolderIds.has(p.folderId)))
    .map(p => ({ id: p.id, name: p.name, content: p.content,
      section: p.section as UserPrompt['section'], enabled: true,
      ...(p.depth != null && { depth: p.depth }),
      ...(p.position != null && { position: p.position }),
    }));
}
