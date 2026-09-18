import type { ReactNode } from "react";

export function AuthLayout({
  children,
  wide,
}: {
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[#121316] px-3 py-6 sm:px-4 sm:py-8">
      <div data-immersive-bg className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[#0B0A10]" />
        <img
          src="/starry-night-bg.jpg"
          alt=""
          className="absolute inset-0 h-full w-full object-cover mix-blend-screen brightness-90 contrast-110 opacity-[0.55]"
          decoding="async"
          width={1920}
          height={1080}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to top, rgba(11, 15, 25, 0.8), rgba(18, 18, 18, 0.5), rgba(18, 18, 18, 0.2))",
          }}
        />
        <div className="absolute -left-32 -top-32 h-96 w-96 rounded-full bg-gold/8 blur-[120px]" />
        <div className="absolute -bottom-32 -right-32 h-96 w-96 rounded-full bg-gold/5 blur-[120px]" />
      </div>
      <div
        className={
          wide
            ? "relative z-10 w-full max-w-[420px]"
            : "relative z-10 w-full max-w-[360px] shrink-0 sm:max-w-[390px]"
        }
      >
        {children}
      </div>
    </div>
  );
}
