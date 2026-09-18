import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> {
  value: number | "";
  onChange: (value: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, value, onChange, min, max, step = 1, disabled, ...props }, ref) => {
    
    const handleIncrement = (e: React.MouseEvent) => {
      e.preventDefault();
      if (disabled) return;
      const current = value === "" ? 0 : Number(value);
      const next = current + step;
      if (max !== undefined && next > max) return;
      onChange(next);
    };

    const handleDecrement = (e: React.MouseEvent) => {
      e.preventDefault();
      if (disabled) return;
      const current = value === "" ? 0 : Number(value);
      const next = current - step;
      if (min !== undefined && next < min) return;
      onChange(next);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (val === "") {
        onChange("");
        return;
      }
      const num = Number(val);
      if (!isNaN(num)) {
        // We do not clamp immediately during typing to allow the user to type freely
        onChange(num);
      }
    };
    
    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      if (value === "") {
         if (props.onBlur) props.onBlur(e);
         return;
      }
      let finalNum = Number(value);
      if (min !== undefined && finalNum < min) finalNum = min;
      if (max !== undefined && finalNum > max) finalNum = max;
      if (finalNum !== value) {
         onChange(finalNum);
      }
      if (props.onBlur) props.onBlur(e);
    }

    const disableMinus = disabled || (value !== "" && min !== undefined && Number(value) <= min);
    const disablePlus = disabled || (value !== "" && max !== undefined && Number(value) >= max);

    return (
      <div
        className={cn(
          "flex w-full items-center overflow-hidden rounded-xl border border-border bg-card shadow-inner transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        <button
          type="button"
          onClick={handleDecrement}
          disabled={disableMinus}
          className="flex h-full min-h-[44px] w-10 shrink-0 items-center justify-center border-r border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Decrease value"
        >
          <Minus className="h-4 w-4" />
        </button>
        <input
          ref={ref}
          type="number"
          value={value}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          className="w-full min-w-0 flex-1 bg-transparent px-3 py-2 text-center text-sm text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          {...props}
        />
        <button
          type="button"
          onClick={handleIncrement}
          disabled={disablePlus}
          className="flex h-full min-h-[44px] w-10 shrink-0 items-center justify-center border-l border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Increase value"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    );
  }
);

NumberInput.displayName = "NumberInput";
