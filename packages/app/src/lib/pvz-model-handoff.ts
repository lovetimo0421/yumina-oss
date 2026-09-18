export interface PvzModelHandoff {
  channel: string;
  accountId: string;
  selectedModel: string;
  lang: "en" | "zh" | "es";
}

export interface PvzModelSelection {
  type: "pvz-dave-model";
  channel: string;
  accountId: string;
  model: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Read the raw query: model ids such as "123" must stay strings, without the
 * router's automatic JSON decoding. The account is a binding, never proof of login. */
export function readPvzModelHandoff(search: string): PvzModelHandoff | null {
  const params = new URLSearchParams(search);
  for (const key of ["channel", "account", "selected", "lang"]) {
    if (params.getAll(key).length > 1) return null;
  }
  const channel = params.get("channel");
  const accountId = params.get("account");
  const selectedModel = params.get("selected") ?? "";
  if (!channel || !UUID_V4.test(channel) || !boundedIdentifier(accountId)) return null;
  if (selectedModel !== "" && !boundedIdentifier(selectedModel)) return null;
  const lang = params.get("lang");
  return { channel, accountId, selectedModel, lang: lang === "zh" || lang === "es" ? lang : "en" };
}

export function createPvzModelSelection(
  handoff: PvzModelHandoff,
  currentAccountId: string,
  model: unknown,
): PvzModelSelection | null {
  if (currentAccountId !== handoff.accountId || !boundedIdentifier(model)) return null;
  return { type: "pvz-dave-model", channel: handoff.channel, accountId: currentAccountId, model };
}

export function isPvzModelAcknowledgement(value: unknown, selection: PvzModelSelection): boolean {
  if (typeof value !== "object" || value === null) return false;
  const ack = value as Record<string, unknown>;
  return ack.type === "pvz-dave-model-ack" && ack.channel === selection.channel
    && ack.accountId === selection.accountId && ack.model === selection.model;
}

export function isPvzModelPickerReturnTo(value: string): boolean {
  if (!value.startsWith("/pvz-models?") || value.length > 2400 || /[#\r\n\\]/.test(value)) return false;
  return readPvzModelHandoff(value.slice("/pvz-models".length)) !== null;
}
