import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTwoTapConfirm } from "@/components/ui/two-tap-delete-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface RoleOption<T extends string> {
  value: T;
  label: string;
}

/**
 * What someone may do on the card, as one small menu (the site's dropdown,
 * not the browser's): the choices, and for a person on the card a Remove at
 * the bottom that asks for a second tap before it acts.
 */
export function RoleMenu<T extends string>({
  value,
  options,
  onChange,
  onRemove,
  disabled,
  label,
  className,
}: {
  value: T;
  options: RoleOption<T>[];
  onChange: (value: T) => void;
  onRemove?: () => void;
  disabled?: boolean;
  /** Accessible name of the trigger. */
  label: string;
  className?: string;
}) {
  const { t } = useTranslation("editor");
  const remove = useTwoTapConfirm(() => onRemove?.());
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu onOpenChange={(open) => { if (!open) remove.disarm(); }}>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={label}
        className={cn(
          "hover-surface inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50",
          className,
        )}
      >
        {current?.label}
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => { if (o.value !== value) onChange(o.value); }} className="gap-2 text-xs">
            <Check className={cn("h-3.5 w-3.5", o.value === value ? "opacity-100" : "opacity-0")} />
            {o.label}
          </DropdownMenuItem>
        ))}
        {onRemove && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                // The first tap arms it and keeps the menu open.
                if (!remove.armed) e.preventDefault();
                remove.fire();
              }}
              className={cn("gap-2 text-xs text-destructive focus:text-destructive", remove.armed && "bg-destructive/10")}
            >
              <span className="h-3.5 w-3.5" />
              {remove.armed ? t("twoTapConfirm") : t("collab.remove", "Remove")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
