import { isPvzModelPickerReturnTo } from "./pvz-model-handoff";

export type SafeAuthReturnTo = string;

/** True when the value is a first-party game path (the PvZ invite flow sends refused joiners
 *  through auth and straight back into their friend's room). Path-only -- never a protocol or
 *  host -- so auth can only ever return somewhere on this origin. */
/** krew.io inside Yumina: `/krew` or `/krew?path=<encoded krew deep link>`. The
 *  krew frame's own Sign-in button sends players through auth and straight back
 *  into the game (features/krew). Path-only like the rest of this file. */
export function isKrewReturnTo(value: string): boolean {
  if (value === "/krew") return true;
  return value.startsWith("/krew?") && value.length <= 700 && !/[\n\r\\]/.test(value);
}

export function isGameReturnTo(value: string): boolean {
  if (isPvzModelPickerReturnTo(value)) return true;
  if (isKrewReturnTo(value)) return true;
  return value.startsWith("/pvz/") && !value.startsWith("//") && value.length <= 200
    && !/[\n\r\\]/.test(value);
}

export function parseSafeAuthReturnTo(value: unknown): SafeAuthReturnTo | undefined {
  if (value === "/delete-account") return value;
  if (typeof value === "string" && isGameReturnTo(value)) return value;
  return undefined;
}

export function readSafeAuthReturnTo(search: string): SafeAuthReturnTo | undefined {
  return parseSafeAuthReturnTo(new URLSearchParams(search).get("returnTo"));
}
