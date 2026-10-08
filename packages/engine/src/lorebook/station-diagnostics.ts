import type { Worldbook } from "../types/index.js";
import { activeNarrator, isAnyModule, resolveStation, WILDCARD_INPUT_KINDS } from "./station.js";

/**
 * What is wrong with a station, said before the creator plays for an hour to
 * find out.
 *
 * Every check here answers one question: can this wire EVER carry anything?
 * Not "is it unusual" — a station is allowed to be strange. Only arrangements
 * that are structurally incapable of doing what they look like they do, which
 * is the failure a creator cannot see, because its symptom is silence.
 *
 * Codes rather than sentences: the console translates them, and the studio
 * agent reads the same list.
 */
export interface StationDiagnostic {
  /** "error" — this can never work. "warn" — it works, but not as it reads. */
  level: "error" | "warn";
  code: string;
  /** Names for the message; never ids, which say nothing to a person. */
  params?: Record<string, string>;
}

/** A module produces archived memories only if it is a narrator that archives.
 *  Everything downstream of that fact is a dead wire. */
const producesMemories = (wb: Worldbook | undefined): boolean => {
  const station = resolveStation(wb);
  return station?.kind === "narrator" && station.onClose === "archive";
};

export function diagnoseStation(
  wb: Worldbook,
  worldbooks: Worldbook[] | undefined,
): StationDiagnostic[] {
  const station = resolveStation(wb);
  if (!station) return [];
  const books = worldbooks ?? [];
  const byId = new Map(books.map((b) => [b.id, b]));
  const out: StationDiagnostic[] = [];

  if (station.kind === "worker") {
    // Both of these mean the module exists and does nothing, forever.
    if (!station.task?.trim()) out.push({ level: "error", code: "worker.noTask" });
    if (!station.trigger) out.push({ level: "error", code: "worker.noTrigger" });
    // A worker with nothing wired in is the one arrangement that looks
    // finished and is not: it runs, it costs a call, and with only its own
    // entries to go on it invents whatever it was asked to report — then
    // hands that to the modules downstream. Proven by running one: asked to
    // record what the traveller did, with no input it wrote about a traveller
    // arriving at an orbital outpost while the player was buying a lantern in
    // a market town. A warning, not an error, because a writer that is meant
    // to invent (a rumour mill, a random event) is a real thing to build.
    // A quiet station reads the last messages itself — it speaks into the
    // story, so the story is its input. One a button calls reads the button's
    // input and what its 回答格式 lets it see (server lib/ai-call.ts), not
    // wired inputs; a fortune teller answering the player is not a recorder
    // making things up.
    const ownInput = station.trigger?.on === "quiet" || station.trigger?.on === "ui";
    if (station.inputs.length === 0 && !ownInput) out.push({ level: "warn", code: "worker.noInputs" });
    if (station.trigger?.on === "after") {
      // It waits for an AI that answers the player; anything else never does.
      const source = byId.get(station.trigger.from);
      if (!source || resolveStation(source)?.kind !== "narrator") out.push({ level: "error", code: "trigger.afterNotAnAi" });
    }
    if (station.trigger?.on === "module-closed") {
      if (isAnyModule(station.trigger.from)) {
        // "Whoever just closed" on a card where nobody ever closes is the same
        // silence as a missing source, and reads as if it were working.
        if (!books.some(producesMemories)) {
          out.push({ level: "error", code: "trigger.noClosingModules" });
        }
      } else {
        const source = byId.get(station.trigger.from);
        if (!source) {
          out.push({ level: "error", code: "trigger.sourceMissing" });
        } else if (!producesMemories(source)) {
          // A module that never closes a run never wakes anything.
          out.push({ level: "error", code: "trigger.sourceNeverCloses", params: { name: source.name } });
        }
      }
    }
  }

  // Put nowhere: it exists and is never in play. Put inside something that is
  // gone, or inside another AI: the same, with a reason.
  if (wb.host === "unplaced") out.push({ level: "warn", code: "ai.unplaced" });
  else if (wb.host !== undefined && wb.host !== "card") {
    const place = byId.get(wb.host);
    if (!place || place.host !== undefined) out.push({ level: "error", code: "ai.placeMissing" });
  }

  if (station.kind === "narrator" && wb.host === undefined) {
    // Two situations that are their own AI, both always on: only the first is
    // the room, and the other is a module the creator believes is running.
    // AIs that live somewhere are never shadowed — two in one place answer
    // one after the other.
    const shadowing = books.find(
      (other) =>
        other.id !== wb.id &&
        other.host === undefined &&
        resolveStation(other)?.kind === "narrator" &&
        other.enabled !== false &&
        wb.enabled !== false &&
        other.activation.mode === "always" &&
        wb.activation.mode === "always" &&
        ((other.order ?? 0) < (wb.order ?? 0) ||
          ((other.order ?? 0) === (wb.order ?? 0) && other.id.localeCompare(wb.id) < 0)),
    );
    if (shadowing) out.push({ level: "warn", code: "narrator.shadowed", params: { name: shadowing.name } });
  }

  for (const input of station.inputs) {
    if (isAnyModule(input.from)) {
      // A role the creator can name but this kind cannot answer: silently
      // dropped at read time, so say it here or it is invisible.
      if (!WILDCARD_INPUT_KINDS.has(input.kind)) {
        out.push({ level: "error", code: "input.anyUnsupported" });
      } else if (input.kind === "memory" && !books.some(producesMemories)) {
        out.push({ level: "error", code: "input.anyNoArchiving" });
      } else if (
        input.kind === "worker" &&
        !books.some((b) => b.id !== wb.id && resolveStation(b)?.kind === "worker")
      ) {
        out.push({ level: "warn", code: "input.anyNoWorkers" });
      }
      continue;
    }
    // The card itself answers its variables, and to an AI behind the scenes
    // the whole conversation's latest messages (what a recorder reads). A
    // narrator has the conversation already.
    if (input.from === "core") {
      if (input.kind !== "variables" && !(input.kind === "transcript" && station.kind === "worker")) out.push({ level: "error", code: "input.coreOnlyVariables" });
      continue;
    }
    const source = byId.get(input.from);
    if (!source) {
      out.push({ level: "error", code: "input.sourceMissing" });
      continue;
    }
    if (input.from === wb.id) {
      out.push({ level: "error", code: "input.self" });
      continue;
    }
    if (input.kind === "memory" && !producesMemories(source)) {
      out.push({ level: "error", code: "input.memoryFromNonArchiving", params: { name: source.name } });
    }
    if (input.kind === "transcript" && !producesMemories(source)) {
      // Transcript is span-addressed, and spans only exist for archiving runs.
      out.push({ level: "error", code: "input.transcriptFromNonArchiving", params: { name: source.name } });
    }
    if (input.kind === "worker") {
      const sourceStation = resolveStation(source);
      if (sourceStation?.kind !== "worker") {
        out.push({ level: "error", code: "input.workerFromNonWorker", params: { name: source.name } });
      } else if (!sourceStation.task?.trim() || !sourceStation.trigger) {
        out.push({ level: "warn", code: "input.workerNeverRuns", params: { name: source.name } });
      }
    }
  }

  return out;
}

/** Everything wrong on the card, for a surface that shows the whole picture
 *  (the studio agent's snapshot, a future canvas badge). */
export function diagnoseAllStations(
  worldbooks: Worldbook[] | undefined,
): Array<{ book: Worldbook; diagnostics: StationDiagnostic[] }> {
  const books = worldbooks ?? [];
  return books
    .map((book) => ({ book, diagnostics: diagnoseStation(book, books) }))
    .filter((row) => row.diagnostics.length > 0);
}

/** Convenience for callers that only need to know whether anyone is narrating
 *  — a card with worker stations and no narrator still plays, but none of its
 *  wires are drawn into the prompt. */
export function hasNarrator(worldbooks: Worldbook[] | undefined, activeIds: ReadonlySet<string>): boolean {
  return activeNarrator(worldbooks, activeIds) !== null;
}
