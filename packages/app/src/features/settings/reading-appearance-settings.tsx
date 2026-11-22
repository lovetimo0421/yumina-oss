import { Moon, Sun } from "lucide-react";
import { useUiStore } from "@/stores/ui";

export function ReadingAppearanceSettings({ labels }: {
  labels: { title: string; dark: string; light: string };
}) {
  const mode = useUiStore((s) => s.playColorMode);
  const setMode = useUiStore((s) => s.setPlayColorMode);
  return (
    <div role="group" aria-label={labels.title} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {(["dark", "light"] as const).map((value) => {
        const Icon = value === "dark" ? Moon : Sun;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => setMode(value)}
            className={`flex min-h-11 items-center gap-3 rounded-xl border px-4 py-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${mode === value ? "border-gold/40 bg-gold/10 text-gold" : "border-white/10 bg-white/[0.02] text-main hover:border-white/20"}`}
          >
            <Icon size={18} aria-hidden="true" />
            {labels[value]}
          </button>
        );
      })}
    </div>
  );
}
