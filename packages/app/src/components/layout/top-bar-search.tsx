import { useRef } from "react";
import { Search } from "lucide-react";
import "./top-bar-search.css";

interface TopBarSearchProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  onConfirm: () => void;
}

/** Discover's search surface, shared by Discover and Library. */
export function TopBarSearch({ value, onValueChange, placeholder, onConfirm }: TopBarSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const confirm = () => {
    inputRef.current?.blur();
    onConfirm();
  };

  return (
    <div className="topbar-search-glass group relative w-full">
      <input
        ref={inputRef}
        type="search"
        name="q"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onFocus={() => { touched.current = true; }}
        onChange={(event) => {
          // Ignore silent browser autofill; typing and chosen suggestions focus the field.
          if (touched.current) onValueChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") confirm();
        }}
        aria-label={placeholder}
        className="topbar-search-input topbar-search-input--glass w-full rounded-full border border-white/5 bg-white/5 pl-11 pr-4 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all focus:border-white/10 focus:bg-white/10 focus:outline-none"
      />
      <button type="button" className="topbar-search-submit" aria-label={placeholder} onClick={confirm}>
        <Search size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
