import { Blocks, Brain, Puzzle, Wrench, Users, BookOpen, Sparkles, type LucideIcon } from "lucide-react";

// Maps an ExtensionDefinition.icon string to a lucide icon. Unknown names fall
// back to Blocks (the generic "extension" glyph).
const ICONS: Record<string, LucideIcon> = {
  brain: Brain,
  blocks: Blocks,
  puzzle: Puzzle,
  wrench: Wrench,
  users: Users,
  book: BookOpen,
  sparkles: Sparkles,
};

export function ExtensionIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name] ?? Blocks;
  return <Icon className={className} />;
}
