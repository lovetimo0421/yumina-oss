import { useRef, useState, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

interface ModelPickerDropdownProps<Value extends string> {
  value: Value;
  options: readonly { value: Value; label: string; icon?: ReactNode }[];
  onValueChange: (value: Value) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Keep picker menus above the sheet and inside the sandbox's style boundary. */
export function ModelPickerDropdown<Value extends string>({
  value, options, onValueChange, label, disabled, className,
}: ModelPickerDropdownProps<Value>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const root = triggerRef.current?.getRootNode();
  const container = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot
    ? root
    : triggerRef.current?.ownerDocument.body;

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={`${label}: ${selected?.label ?? value}`}
        className={cn(
          "group flex min-w-0 items-center justify-between gap-2 rounded-xl border border-white/10 bg-[#242228] px-3 text-xs text-white/70 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white data-[state=open]:border-primary/40 data-[state=open]:bg-primary/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:min-h-11",
          className,
        )}
      >
        {selected?.icon}
        <span className="min-w-0 truncate">{selected?.label}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-white/40 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal container={container}>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          aria-label={label}
          onClick={(event) => event.stopPropagation()}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          className="yumina-platform-overlay-surface z-[10030] min-w-[max(12rem,var(--radix-dropdown-menu-trigger-width))] max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto rounded-2xl border border-white/10 bg-[#242129] p-1.5 text-white/75 shadow-[0_16px_48px_rgba(0,0,0,0.45)] outline-none"
        >
          <DropdownMenu.RadioGroup value={value} onValueChange={(next) => {
            const option = options.find((entry) => entry.value === next);
            if (option && option.value !== value) onValueChange(option.value);
          }}>
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="flex min-h-11 cursor-pointer select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs outline-none transition-colors data-[highlighted]:bg-white/[0.07] data-[highlighted]:text-white data-[state=checked]:bg-primary/10 data-[state=checked]:text-primary"
              >
                {option.icon}
                <span className="flex-1">{option.label}</span>
                <span className="h-3.5 w-3.5 shrink-0">
                  <DropdownMenu.ItemIndicator><Check aria-hidden="true" className="h-3.5 w-3.5" /></DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
