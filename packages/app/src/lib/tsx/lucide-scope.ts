import * as LucideIcons from "lucide-react";

/**
 * All Lucide icons exposed to custom components via the `Icons` scope variable.
 * Usage in custom components: `<Icons.Heart size={16} />` or `const { Heart } = Icons;`
 *
 * Every PascalCase icon from lucide-react is available — browse the full list at:
 * https://lucide.dev/icons
 *
 * Lucide icons are forwardRef components (objects with $$typeof), not plain functions.
 * We check for both to be safe.
 */
export const LucideScope: Record<string, unknown> = {};
for (const [name, value] of Object.entries(LucideIcons)) {
  // Include PascalCase exports that are React components (functions OR forwardRef objects)
  if (
    /^[A-Z]/.test(name) &&
    value != null &&
    (typeof value === "function" ||
      (typeof value === "object" && "$$typeof" in (value as Record<string, unknown>)))
  ) {
    LucideScope[name] = value;
  }
}
