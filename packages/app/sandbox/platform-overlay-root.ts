const HOST_ATTRIBUTE = "data-yumina-platform-overlay-host";
const MOUNT_ID = "yumina-platform-overlay-mount";
const mounts = new WeakMap<Document, HTMLElement>();

const SHADOW_RESET = `
  :host {
    all: initial !important;
    position: fixed !important;
    inset: 0 !important;
    z-index: 2147483000 !important;
    display: block !important;
    pointer-events: none !important;
    color-scheme: dark !important;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif !important;
    font-size: 16px !important;
    line-height: 1.5 !important;
    -webkit-font-smoothing: antialiased !important;
    -moz-osx-font-smoothing: grayscale !important;
  }

  #${MOUNT_ID} {
    display: contents;
  }

  .yumina-platform-overlay-surface {
    pointer-events: auto;
    font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
      "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 16px;
    line-height: 1.5;
  }
`;

/**
 * Create the platform-owned overlay layer before creator code mounts.
 *
 * The sandbox iframe isolates a world from the host app, but it does not
 * isolate the world's global CSS from Yumina components rendered inside the
 * same iframe. A shadow root gives model/context dialogs their own cascade.
 * Only styles already present at bootstrap are copied, so later creator style
 * tags can never enter the platform boundary.
 */
export function initializeSandboxPlatformOverlay(doc: Document = document): HTMLElement {
  const cached = mounts.get(doc);
  if (cached?.isConnected) return cached;

  const existingHost = doc.querySelector<HTMLElement>(`[${HOST_ATTRIBUTE}]`);
  const existingMount = existingHost?.shadowRoot?.getElementById(MOUNT_ID) as HTMLElement | null;
  if (existingMount) {
    mounts.set(doc, existingMount);
    return existingMount;
  }

  const platformStyles = Array.from(
    doc.head.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style, link[rel="stylesheet"]'),
  );
  for (const style of platformStyles) {
    style.setAttribute("data-yumina-platform-style", "true");
  }

  const host = doc.createElement("div");
  host.setAttribute(HOST_ATTRIBUTE, "true");
  const shadow = host.attachShadow({ mode: "open" });

  for (const style of platformStyles) {
    shadow.appendChild(style.cloneNode(true));
  }

  const reset = doc.createElement("style");
  reset.setAttribute("data-yumina-platform-reset", "true");
  reset.textContent = SHADOW_RESET;
  shadow.appendChild(reset);

  const mount = doc.createElement("div");
  mount.id = MOUNT_ID;
  shadow.appendChild(mount);
  doc.body.appendChild(host);
  mounts.set(doc, mount);
  return mount;
}
