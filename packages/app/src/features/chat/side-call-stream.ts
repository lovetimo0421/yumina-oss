/**
 * SSE reader for `api.ai.complete` side calls.
 *
 * The completions endpoint (packages/server/src/routes/completions.ts) emits
 * three frame types, and TWO of them carry a `content` field:
 *
 *   event: text    data: {"content":"<one chunk>"}
 *   event: error   data: {"error":"<message>"}
 *   event: done    data: {"content":"<the ENTIRE reply>","usage":{...}}
 *
 * A reader that scans for `data:` lines and appends anything with a `content`
 * key therefore appends the whole reply a SECOND time when `done` lands, and
 * drops `error` on the floor because that payload has no `content`. Cards saw
 * every side call come back doubled — a JSON reply arrived as `{...}{...}`,
 * which no card's parser accepts, so cards silently fell through to their
 * hardcoded fallbacks — and a failed call was indistinguishable from a short
 * one. Discriminating on the frame's event name is the whole fix, so parse
 * real SSE frames instead of grepping lines.
 */

export interface SideCallStreamHandlers {
  /** One chunk of newly generated text. */
  onDelta: (text: string) => void;
  /** The finished reply. Fires at most once, and never after onError. */
  onDone: (fullText: string) => void;
  /** Generation failed. Fires at most once, and never after onDone. */
  onError: (message: string) => void;
}

export interface SideCallStreamReader {
  /** Feed a decoded chunk of the response body. */
  push: (chunk: string) => void;
  /** The response body ended. Settles the call if no frame did. */
  end: () => void;
}

interface Frame {
  event: string;
  data: string;
}

/** Strip the single optional space after the field colon (per the SSE spec). */
function fieldValue(line: string, colonAt: number): string {
  const raw = line.slice(colonAt + 1);
  return raw.startsWith(" ") ? raw.slice(1) : raw;
}

export function createSideCallStreamReader(
  handlers: SideCallStreamHandlers,
): SideCallStreamReader {
  let buffer = "";
  let accumulated = "";
  let settled = false;

  // Fields of the frame currently being assembled.
  let event = "";
  let dataLines: string[] = [];

  const resetFrame = () => {
    event = "";
    dataLines = [];
  };

  const settleDone = (fullText: string) => {
    if (settled) return;
    settled = true;
    handlers.onDone(fullText);
  };

  const settleError = (message: string) => {
    if (settled) return;
    settled = true;
    handlers.onError(message);
  };

  const emit = ({ event: name, data }: Frame) => {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return; // Malformed frame — skip it rather than killing the stream.
    }

    if (name === "error") {
      settleError(
        typeof payload.error === "string" && payload.error
          ? payload.error
          : "Generation failed",
      );
      return;
    }

    if (name === "done") {
      // `done.content` is the server's authoritative full reply. Prefer it, and
      // fall back to what actually streamed if a future server build drops it.
      const full = typeof payload.content === "string" ? payload.content : accumulated;
      settleDone(full);
      return;
    }

    // Default to treating an unnamed frame as text: an SSE frame with no
    // `event:` line is a plain `message`, and only the text path sends those.
    if (name === "text" || name === "" || name === "message") {
      const chunk = typeof payload.content === "string" ? payload.content : "";
      if (!chunk) return;
      accumulated += chunk;
      handlers.onDelta(chunk);
    }
  };

  const consumeLine = (line: string) => {
    if (line === "") {
      // Blank line terminates a frame. Ignore keep-alive blank lines.
      if (dataLines.length > 0) emit({ event, data: dataLines.join("\n") });
      resetFrame();
      return;
    }
    if (line.startsWith(":")) return; // Comment / heartbeat.

    const colonAt = line.indexOf(":");
    if (colonAt === -1) return; // Field with no value — nothing we consume.

    const field = line.slice(0, colonAt);
    if (field === "event") event = fieldValue(line, colonAt);
    else if (field === "data") dataLines.push(fieldValue(line, colonAt));
    // `id` and `retry` are not used by this endpoint.
  };

  return {
    push(chunk: string) {
      if (settled) return;
      buffer += chunk.replace(/\r\n?/g, "\n");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
        if (settled) return; // A done/error frame ends the call immediately.
      }
    },

    end() {
      if (settled) return;
      // The body closed. Anything still buffered is a complete final line.
      if (buffer) {
        consumeLine(buffer);
        buffer = "";
      }
      if (!settled && dataLines.length > 0) {
        emit({ event, data: dataLines.join("\n") });
        resetFrame();
      }
      // No terminal frame arrived (connection cut mid-stream). Hand back
      // whatever streamed rather than pretending the call never happened.
      settleDone(accumulated);
    },
  };
}
