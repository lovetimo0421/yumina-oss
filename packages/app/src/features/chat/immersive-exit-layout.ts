export const MOBILE_EXIT_AUTO_COLLAPSE_MS = 2000;

export type MobileExitActivation = "expand" | "exit";

export function getMobileExitActivation(
  isTouch: boolean,
  collapsed: boolean,
): MobileExitActivation {
  return isTouch && collapsed ? "expand" : "exit";
}

export function scheduleMobileExitAutoCollapse(
  onCollapse: () => void,
  schedule: (callback: () => void, delayMs: number) => number,
): number {
  return schedule(onCollapse, MOBILE_EXIT_AUTO_COLLAPSE_MS);
}

export interface ImmersiveExitLayout {
  shellClassName: string;
  shellStyle?: {
    top: string;
  };
  systemFullscreenButtonClassName: string;
  exitButtonClassName: string;
}

export function getImmersiveExitLayout(
  isTouch: boolean,
  collapsed = false,
): ImmersiveExitLayout {
  if (isTouch) {
    return {
      shellClassName: collapsed
        ? "fixed right-[env(safe-area-inset-right,0px)] z-[100] flex items-start gap-0"
        : "fixed right-[max(0.5rem,env(safe-area-inset-right,0px))] z-[100] flex items-start gap-2",
      shellStyle: {
        top: "env(safe-area-inset-top, 0px)",
      },
      systemFullscreenButtonClassName:
        "flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-black/60 text-white/70 backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white active:bg-black/90",
      exitButtonClassName: collapsed
        ? "flex h-11 w-8 min-w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-l-lg rounded-r-none bg-black/70 p-0 text-white/85 opacity-75 shadow-lg backdrop-blur-sm transition-[width,border-radius,opacity,background-color] duration-200 motion-reduce:transition-none active:bg-black/95"
        : "flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-black/70 text-white/85 shadow-lg backdrop-blur-sm transition-[width,border-radius,opacity,background-color] duration-200 motion-reduce:transition-none hover:bg-black/90 hover:text-white active:bg-black/95",
    };
  }

  return {
    shellClassName: "immersive-exit-button-shell fixed right-4 top-4 z-[100]",
    systemFullscreenButtonClassName:
      "absolute right-12 top-0 rounded-lg bg-black/60 p-3 text-white/70 opacity-50 backdrop-blur-sm transition-all hover:bg-black/80 hover:text-white",
    exitButtonClassName:
      "absolute right-0 top-0 rounded-lg bg-black/60 p-2 text-white/70 backdrop-blur-sm transition-all hover:bg-black/80 hover:text-white",
  };
}
