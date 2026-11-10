import assert from "node:assert/strict";
import test from "node:test";
import { act, type ComponentType } from "react";
import { clientDom, loadClientModule } from "@/lib/feed-beacon.test-helpers";
import english from "@/locales/en/common.json";

async function mount() {
  const env = clientDom();
  let actor = "viewer";
  let openCount = 0;
  const { SensitiveCoverImage, MEDIA_SETTINGS_HREF } = loadClientModule<{
    SensitiveCoverImage: ComponentType<{ src: string; conceal: boolean; alt: string; decorative?: boolean }>;
    MEDIA_SETTINGS_HREF: string;
  }>(new URL("./sensitive-cover-image.tsx", import.meta.url), {
    "./sensitive-cover-image.css": {},
    "react-i18next": { useTranslation: () => ({ t: (key: string) => english.sensitiveCover[key.split(".")[1] as keyof typeof english.sensitiveCover] }) },
    "@/lib/auth-client": { useSession: () => ({ data: actor ? { user: { id: actor } } : null }) },
    "@/lib/asset-url": { cardImageUrl: (src: string, width: number, options: { still: boolean }) => `${src}?width=${width}&still=${options.still}` },
    "@/lib/cover-crop": { CroppedImage: ({ src, alt }: { src: string; alt: string }) => <img data-clear-cover src={src} alt={alt} /> },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const render = async (conceal = true, src = "/one.jpg", decorative = false) => {
    await act(async () => root.render(<div onClick={() => openCount++}>
      <SensitiveCoverImage src={src} alt="First" conceal={conceal} decorative={decorative} />
      <SensitiveCoverImage src="/two.jpg" alt="Second" conceal={conceal} decorative={decorative} />
    </div>));
  };
  await render();
  const document = env.dom.window.document;
  return { env, document, render, MEDIA_SETTINGS_HREF, opens: () => openCount,
    actor: (next: string) => { actor = next; },
    click: async (selector: string) => { await act(async () => document.querySelector<HTMLElement>(selector)!.click()); },
    cleanup: async () => { await act(async () => root.unmount()); env.restore(); },
  };
}

test("covers begin concealed; reveal affects one image, retains focus, and never opens the story", async () => {
  const app = await mount();
  try {
    assert.equal(app.document.querySelectorAll('[data-cover-hidden="true"]').length, 2);
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 0);
    assert.match(app.document.querySelector("img")!.src, /width=24&still=true/);
    await app.click(".sensitive-cover-show");
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 1);
    assert.equal(app.document.querySelectorAll('[data-cover-hidden="true"]').length, 1);
    assert.equal(app.document.activeElement, app.document.querySelector(".sensitive-cover-hide"));
    assert.equal(app.opens(), 0);
    await app.click(".sensitive-cover-hide");
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 0);
    assert.equal(app.document.activeElement, app.document.querySelector(".sensitive-cover-show"));
  } finally { await app.cleanup(); }
});

test("source, viewer and preference changes reset temporary consent; safe covers render normally", async () => {
  const app = await mount();
  try {
    await app.click(".sensitive-cover-show");
    await app.render(true, "/replacement.jpg");
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 0);
    await app.click(".sensitive-cover-show");
    app.actor("another-viewer");
    await app.render(true, "/replacement.jpg");
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 0);
    await app.render(false);
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 2);
    assert.equal(app.document.querySelector("button,a"), null);
    await app.render(true);
    assert.equal(app.document.querySelectorAll("[data-clear-cover]").length, 0);
    app.actor("");
    await app.render();
    assert.equal(app.document.querySelectorAll('[data-cover-hidden="true"]').length, 2);
  } finally { await app.cleanup(); }
});

test("settings links target the exact preference without triggering story navigation", async () => {
  const app = await mount();
  try {
    const link = app.document.querySelector<HTMLAnchorElement>(".sensitive-cover-settings")!;
    assert.equal(link.getAttribute("href"), "/app/settings#content-safety/blur-sensitive");
    app.document.addEventListener("click", event => event.preventDefault(), { capture: true });
    await app.click(".sensitive-cover-settings");
    assert.equal(app.opens(), 0);
    assert.equal(app.document.querySelectorAll('[data-cover-hidden="true"]').length, 2);
    await app.render(true, "/one.jpg", true);
    assert.equal(app.document.querySelector("button,a"), null, "decorative carousel choices have no nested actions");
    assert.equal(app.document.querySelectorAll('[data-cover-hidden="true"]').length, 2);
  } finally { await app.cleanup(); }
});
