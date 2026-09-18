import { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import { useTranslation } from "react-i18next";

interface SortDropdownOption {
  value: string;
  label: string;
}

interface SortDropdownProps {
  value: string;
  onChange: (value: string) => void;
  options: SortDropdownOption[];
}

export function SortDropdown({ value, onChange, options }: SortDropdownProps) {
  const { t } = useTranslation("library");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[13px] font-bold text-foreground transition-colors hover:text-primary"
      >
        <span className="text-[12px] font-normal text-muted-foreground">{t("sort.sortBy")}</span>
        {selected?.label ?? "Select"}
        <ChevronDown
          size={14}
          className={`text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 min-w-[160px] animate-in fade-in slide-in-from-top-1 duration-150 rounded-xl border border-white/10 bg-[#1E1E1E] p-1 shadow-2xl shadow-black/40">
          {options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] transition-colors ${
                opt.value === value
                  ? "bg-gold/10 font-bold text-gold"
                  : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
              }`}
            >
              {opt.label}
              {opt.value === value && <Check size={14} className="text-gold" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
