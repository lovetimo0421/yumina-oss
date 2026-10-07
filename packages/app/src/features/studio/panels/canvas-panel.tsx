import { useMemo } from "react";
import { useEditorStore } from "@/stores/editor";
import { useStudioSidebarStore } from "@/stores/studio-sidebar";
import {
  CanvasShell,
  LiveFrontendPreview,
} from "@/features/editor/components/preview/live-frontend-preview";

/**
 * The Studio's preview dock.
 *
 * The renderer itself is not a Studio thing — the module page in the normal
 * editor shows a module's scene with the same component, and the blueprint's
 * interface block is a third caller. What IS a Studio thing is the two
 * remembered choices below: which opening the dock is previewing, and the
 * variable overrides the sidebar is forcing. Those live in the Studio's own
 * store and are handed down, rather than read from inside a component that
 * other editors mount.
 */
export function useStudioPreviewChoices() {
  const worldKey = useEditorStore((s) => s.worldDraft.id || "new");
  const greetingId = useStudioSidebarStore((s) => s.previewGreetingIdByWorld[worldKey]);
  const overridesByWorld = useStudioSidebarStore((s) => s.previewVariableOverridesByWorld);
  const overrides = useMemo(() => overridesByWorld[worldKey], [overridesByWorld, worldKey]);
  return { greetingId, overrides };
}

export function CanvasPanel() {
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const { greetingId, overrides } = useStudioPreviewChoices();

  const hasFiles = !!worldDraft.rootComponent?.files && Object.keys(worldDraft.rootComponent.files).length > 0;
  return (
    <CanvasShell isEmpty={!hasFiles} fullBleed>
      <LiveFrontendPreview greetingId={greetingId} overrides={overrides} />
    </CanvasShell>
  );
}
