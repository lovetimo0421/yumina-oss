import type { ReactNode } from "react";

interface LibraryEmptyStateProps {
  icon: ReactNode;
  headline: string;
  subtitle: string;
  ctaLabel?: string;
  onCta?: () => void;
}

export function LibraryEmptyState({
  icon,
  headline,
  subtitle,
  ctaLabel,
  onCta,
}: LibraryEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-24">
      <div className="relative mb-6 flex items-center justify-center">
        <div
          className="pointer-events-none absolute rounded-full opacity-25 blur-3xl"
          style={{
            background: "radial-gradient(circle, #C9A25E 0%, transparent 70%)",
            width: "160px",
            height: "160px",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
          }}
        />
        <div className="library-overview-surface library-overview-surface--inset relative z-10 flex h-20 w-20 items-center justify-center rounded-2xl text-[#C9A25E]">
          {icon}
        </div>
      </div>

      <h3 className="mb-2 text-center text-[18px] font-bold text-white">
        {headline}
      </h3>
      <p className="mb-6 max-w-[280px] text-center text-[13px] leading-relaxed text-[#B9B6AE]">
        {subtitle}
      </p>

      {ctaLabel && onCta && (
        <button
          onClick={onCta}
          className="cursor-pointer rounded-lg bg-[#C9A25E] px-6 py-2 text-sm font-bold text-black transition-colors hover:bg-[#C9A25E]/90"
        >
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
