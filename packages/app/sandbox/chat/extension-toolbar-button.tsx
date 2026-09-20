import type { LucideIcon } from "lucide-react";

/** Shared appearance for extension launchers beside the story-model picker. */
export function ExtensionToolbarButton({ icon: Icon, label, title = label, onClick }: {
  icon: LucideIcon;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="group mx-auto flex shrink-0 items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.05] px-3 py-1.5 transition-all hover:border-white/20 hover:bg-white/[0.09]"
    >
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-primary/70 group-hover:text-primary" />
      <span className="text-[11px] font-medium text-white/70 group-hover:text-white transition-colors">
        {label}
      </span>
    </button>
  );
}
