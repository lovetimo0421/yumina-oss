import { ArrowLeft, Brain, Cpu, Maximize, MoreHorizontal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface FullscreenFloatingControlsProps {
  backLabel: string;
  moreLabel: string;
  modelLabel: string;
  memoryLabel?: string;
  fullscreenLabel: string;
  showActions: boolean;
  onBack: () => void;
  onModel: () => void;
  onMemory: () => void;
  onFullscreen: () => void;
  onInteractionStart: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

export function shouldPauseFloatingBarAutoHide(pointerOverBar: boolean, menuOpen: boolean) {
  return pointerOverBar || menuOpen;
}

export function FullscreenFloatingControls({
  backLabel,
  moreLabel,
  modelLabel,
  memoryLabel,
  fullscreenLabel,
  showActions,
  onBack,
  onModel,
  onMemory,
  onFullscreen,
  onInteractionStart,
  onMenuOpenChange,
}: FullscreenFloatingControlsProps) {
  return (
    <>
      <button
        onPointerDown={onInteractionStart}
        onClick={onBack}
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.035] text-muted-foreground transition-all hover:-translate-y-px hover:bg-gold/[0.10] hover:text-action-primary-hover"
        title={backLabel}
        aria-label={backLabel}
      >
        <ArrowLeft className="h-[18px] w-[18px]" />
      </button>
      {showActions && (
        <>
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger asChild>
              <button
                onPointerDown={onInteractionStart}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.035] text-muted-foreground transition-all hover:-translate-y-px hover:bg-gold/[0.10] hover:text-action-primary-hover data-[state=open]:bg-gold/[0.12] data-[state=open]:text-action-primary-hover"
                title={moreLabel}
                aria-label={moreLabel}
              >
                <MoreHorizontal className="h-[18px] w-[18px]" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              sideOffset={8}
              className="min-w-52 rounded-xl border-gold/25 bg-popover/95 p-1.5 text-foreground shadow-[0_18px_45px_rgba(0,0,0,0.5)] backdrop-blur-xl"
            >
              <DropdownMenuItem
                onSelect={onModel}
                className="min-h-11 gap-2.5 rounded-lg px-3 focus:bg-gold/[0.10] focus:text-foreground"
              >
                <Cpu className="h-4 w-4 text-gold" />
                {modelLabel}
              </DropdownMenuItem>
              {memoryLabel && (
                <DropdownMenuItem
                  onSelect={onMemory}
                  className="min-h-11 gap-2.5 rounded-lg px-3 focus:bg-gold/[0.10] focus:text-foreground"
                >
                  <Brain className="h-4 w-4 text-gold" />
                  {memoryLabel}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            onPointerDown={onInteractionStart}
            onClick={onFullscreen}
            className="flex h-11 w-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-0 text-[0.9rem] font-semibold text-primary-foreground shadow-[0_10px_26px_rgba(0,0,0,0.32),0_0_18px_rgba(201,162,94,0.16)] transition-all hover:-translate-y-px hover:bg-primary-hover hover:text-primary-foreground sm:w-auto sm:px-3.5"
            title={fullscreenLabel}
            aria-label={fullscreenLabel}
          >
            <Maximize className="h-[18px] w-[18px]" />
            <span className="hidden whitespace-nowrap sm:inline">{fullscreenLabel}</span>
          </button>
        </>
      )}
    </>
  );
}
