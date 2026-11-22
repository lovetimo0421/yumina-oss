/**
 * Past this temperature several paid models (GLM Flash, Mistral, Qwen…) start
 * writing garbled multilingual word salad, and the player still pays for the
 * turn. The cap stays where it is; every temperature control just warns once
 * the value goes over this line.
 */
export const GARBLE_RISK_TEMPERATURE = 1;

export function temperatureMayGarble(temperature: number | null | undefined): boolean {
  return typeof temperature === "number" && Number.isFinite(temperature) && temperature > GARBLE_RISK_TEMPERATURE;
}
