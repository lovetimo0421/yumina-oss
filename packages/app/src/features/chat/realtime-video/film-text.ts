/**
 * Words the film window shows (the toolbar status, the process log, the shot states): the
 * controller keeps them as an i18n key under `chat:film.` plus its values, and they become text
 * only when shown, in the viewer's language (filmText). Nothing tests the words themselves:
 * a shot's state is `ShotStatus.state`.
 */
import type en from "@/locales/en/chat.json";

type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** A key under `chat:film.`, e.g. "step.streamConnected" or "shotState.queued". */
export type FilmKey = Leaves<(typeof en)["film"]>;

/** One value of a FilmText: a number or word as is, another FilmText (shown in the same
 *  language), names (joined with the language's list separator) or parts (joined with " · "). */
export type FilmParam = string | number | FilmText | string[] | FilmText[];
export interface FilmText {
  key: FilmKey;
  params?: Record<string, FilmParam>;
}

/** A sent shot's state: what the logic reads. The words come from its key and params. */
export type ShotState = "sent" | "queued" | "generating" | "ready" | "applied" | "rejected" | "shown" | "dropped" | "failed";
export interface ShotStatus extends FilmText {
  state: ShotState;
}

export const ft = (key: FilmKey, params?: Record<string, FilmParam>): FilmText => (params ? { key, params } : { key });
/** Text from outside the app (the story, the player, an error message), shown as it is. */
export const rawText = (text: string): FilmText => ({ key: "step.text", params: { text } });
export const shotStatus = (state: ShotState, key: FilmKey, params?: Record<string, FilmParam>): ShotStatus => ({ state, ...ft(key, params) });

/** Why a reply's short film was not made (turnVideo.reason) → its words. */
export const SHORT_REASON_KEYS: Record<string, FilmKey> = { busy: "shortBusy", credits: "noCredits", timeout: "shortTimeout", unavailable: "unavailable" };
export const shortReason = (reason: string | undefined): FilmText => ft(SHORT_REASON_KEYS[reason ?? ""] ?? "unavailable");

/** A `t` bound to the chat namespace (react-i18next's, or i18n.t with ns "chat"). */
export type FilmT = (key: string, params?: Record<string, string | number>) => string;

function paramText(t: FilmT, v: FilmParam): string | number {
  if (typeof v === "string" || typeof v === "number") return v;
  if (!Array.isArray(v)) return filmText(t, v);
  const list = v as (string | FilmText)[];
  return list.every((x) => typeof x === "string")
    ? list.join(t("film.listSep"))
    : list.map((x) => (typeof x === "string" ? x : filmText(t, x))).join(" · ");
}

export function filmText(t: FilmT, m: FilmText | null | undefined): string {
  if (!m) return "";
  const params: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(m.params ?? {})) params[k] = paramText(t, v);
  return t(`film.${m.key}`, params);
}
