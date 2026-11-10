/**
 * What a run has left broken or unchecked, so its last word to the creator can
 * be honest.
 *
 * In runs that still had a failed write nobody redid, 44% of final replies said
 * the task was done; 282 replies announced completion while validation still
 * reported errors the run itself introduced. The model forgets a failure three
 * iterations back. This keeps the list and hands it back inside a tool result
 * (withToolNote) whenever it changes, so the reply that ends the run is written
 * with it in view.
 *
 * Interface changes are listed apart: Studio cannot see the card's screen, so a
 * changed interface is unchecked rather than broken, and the reply should say
 * so instead of "it looks good".
 */
export class UnresolvedWork {
  /** Entity id (or tool name when there is none) → the latest failure. */
  private readonly failedWrites = new Map<string, { tool: string; error: string }>();
  private validationErrors: string[] = [];
  private readonly unseenUi = new Set<string>();
  private lastNote = "";

  recordWrite(tool: string, id: string | undefined, ok: boolean, error?: string): void {
    const key = id || tool;
    if (ok) this.failedWrites.delete(key);
    else this.failedWrites.set(key, { tool, error: (error ?? "failed").split("\n")[0]!.slice(0, 160) });
  }

  /** The run's own validation errors as of now (pre-existing ones excluded). */
  recordValidation(errors: Array<{ code: string; message: string }>): void {
    this.validationErrors = errors.map((e) => `[${e.code}] ${e.message.slice(0, 160)}`);
  }

  /** An interface change that landed and that nobody has looked at yet. */
  recordUnseenUi(what: string): void {
    this.unseenUi.add(what);
  }

  /** Counts for the run-end analytics event. */
  summary(): { failedWrites: number; validationErrors: number; unseenUi: number } {
    return { failedWrites: this.failedWrites.size, validationErrors: this.validationErrors.length, unseenUi: this.unseenUi.size };
  }

  /** The note to attach, or null when nothing is outstanding or the list is
   *  unchanged since it was last shown. */
  note(): string | null {
    const lines: string[] = [];
    for (const [id, f] of this.failedWrites) lines.push(`- ${f.tool} "${id}" failed and was not redone: ${f.error}`);
    for (const e of this.validationErrors.slice(0, 6)) lines.push(`- validation: ${e}`);
    if (this.validationErrors.length > 6) lines.push(`- validation: +${this.validationErrors.length - 6} more`);
    const parts: string[] = [];
    if (lines.length) {
      parts.push(`Still not done in this request:\n${lines.join("\n")}\nFix these, or when you finish, tell the creator plainly which of them remain. Do not describe the task as done or working while any of them stand.`);
    }
    if (this.unseenUi.size) {
      parts.push(`Not seen yet: you changed the interface (${[...this.unseenUi].slice(0, 6).join(", ")}) and nobody has looked at it. When you finish, say it has not been checked on screen and what the creator should look at — never that it looks good.`);
    }
    const text = parts.join("\n\n");
    if (text === this.lastNote) return null;
    this.lastNote = text;
    return text || null;
  }
}
