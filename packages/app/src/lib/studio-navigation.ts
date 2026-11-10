export const OPEN_STUDIO_EVENT = "yumina:open-studio";

export function openStudio(worldId: string) {
  window.dispatchEvent(new CustomEvent<string>(OPEN_STUDIO_EVENT, { detail: worldId }));
}
