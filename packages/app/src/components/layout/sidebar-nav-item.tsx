import type { LucideIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

type SidebarNavItemProps = {
  label: string;
  icon: LucideIcon;
  isActive: boolean;
  className?: string;
} & (
  | { to: string; onClick?: never }
  | { to?: never; onClick: () => void }
);

export function SidebarNavItem({
  label,
  icon: Icon,
  isActive,
  className,
  to,
  onClick,
}: SidebarNavItemProps) {
  const itemClassName = cn(
    "sidebar-nav-item",
    isActive && "sidebar-nav-item--active",
    className
  );

  const content = (
    <>
      <Icon
        className="sidebar-nav-icon"
        strokeWidth={isActive ? 2.5 : 2}
        aria-hidden
      />
      <span className="sidebar-nav-label">{label}</span>
    </>
  );

  if (to) {
    return (
      <Link to={to} preload="intent" className={itemClassName}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={itemClassName}>
      {content}
    </button>
  );
}
