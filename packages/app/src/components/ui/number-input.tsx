import * as React from "react";
import { cn } from "@/lib/utils";
import { TokenNumberInput } from "./token-number-input";

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "type"> {
  value: number | "";
  onChange: (value: number | "") => void;
  min?: number;
  max?: number;
  step?: number;
  /** Keep integer edits local until blur/Enter instead of persisting each digit. */
  commitOnBlur?: boolean;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, value, onChange, min, max, step = 1, disabled, commitOnBlur = false, ...props }, ref) => {
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

    return (
      <div
        className={cn(
          "flex w-full items-center overflow-hidden rounded-xl border border-border bg-card shadow-inner transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/50",
          disabled && "cursor-not-allowed opacity-50",
          className
        )}
      >
        {commitOnBlur && typeof value === "number" && min !== undefined && max !== undefined ? <TokenNumberInput
          {...props}
          ref={ref}
          value={value}
          min={min}
          max={max}
          onCommit={onChange}
          disabled={disabled}
          className="min-h-[44px] w-full min-w-0 flex-1 bg-transparent px-4 py-2 text-sm text-foreground outline-none"
        /> : <input
          ref={ref}
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          className="min-h-[44px] w-full min-w-0 flex-1 bg-transparent px-4 py-2 text-sm text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          {...props}
        />}
      </div>
    );
  }
);

NumberInput.displayName = "NumberInput";
