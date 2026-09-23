"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Shield,
  Crosshair,
  Layers,
  Target,
  Settings,
  ChevronLeft,
  ChevronRight,
  Zap,
  X,
  FileText,
  ChevronDown,
  Timer,
  History,
  Calculator,
  Library,
  Search,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { sectionsForGroup } from "@/lib/categories";

const PRIMARY_NAV_ITEMS = [
  { label: "Command", href: "/", icon: Zap, description: "Overview & stats" },
  {
    label: "Builds",
    href: "/builds",
    icon: Layers,
    description: "Build configurations",
  },
  {
    label: "Ammo",
    href: "/ammo",
    icon: Target,
    description: "Ammunition storage",
  },
] as const;

const RANGE_CHILD_ITEMS = [
  { label: "Log Range Session", href: "/range/log-session", icon: Target },
  {
    label: "Range Session History",
    href: "/range/session-history",
    icon: History,
  },
  { label: "Log a Drill", href: "/range/log-drill", icon: Timer },
  { label: "Drill Performance", href: "/range/drill-performance", icon: Timer },
  { label: "Drill Library", href: "/range/drill-library", icon: Library },
  {
    label: "Hit Factor Calculator",
    href: "/range/hit-factor",
    icon: Calculator,
  },
] as const;

const BOTTOM_NAV_ITEMS = [
  {
    label: "Accessories",
    href: "/accessories",
    icon: Crosshair,
    description: "All accessories",
  },
  {
    label: "Documents",
    href: "/documents",
    icon: FileText,
    description: "Document library",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Configuration",
  },
] as const;

function NavGroup({
  label,
  description,
  href,
  icon: Icon,
  group,
  pathname,
  collapsed,
  counts,
  onNavigate,
}: {
  label: string;
  description: string;
  href: string;
  icon: LucideIcon;
  group: "vault" | "gear";
  pathname: string;
  collapsed: boolean;
  counts: Record<string, number>;
  onNavigate?: () => void;
}) {
  const isActive = pathname.startsWith(href);
  const [open, setOpen] = useState(isActive);
  const sectionOpen = isActive || open;
  const sections = sectionsForGroup(group);

  return (
    <div>
      <div className="flex items-center">
        <Link
          href={href}
          onClick={() => onNavigate?.()}
          className={cn(
            "flex flex-1 items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-all duration-150 group relative",
            isActive
              ? "bg-[#00C2FF]/10 text-[#00C2FF] border border-[#00C2FF]/20"
              : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
          )}
          title={collapsed ? label : undefined}
        >
          {isActive && (
            <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-[#00C2FF]" />
          )}
          <Icon
            className={cn(
              "shrink-0 transition-colors",
              collapsed ? "h-5 w-5" : "h-4 w-4",
              isActive ? "text-[#00C2FF]" : "text-vault-text-faint",
            )}
          />
          {!collapsed && (
            <span className="min-w-0 text-left">
              <span className="block truncate font-medium tracking-wide">
                {label}
              </span>
              <span className="block truncate text-[11px] text-vault-text-faint">
                {description}
              </span>
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            aria-label={`${sectionOpen ? "Collapse" : "Expand"} ${label} sections`}
            aria-expanded={sectionOpen}
            className="p-2 text-vault-text-faint hover:text-vault-text"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                sectionOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </button>
        )}
      </div>

      {!collapsed && sectionOpen && (
        <div className="mt-1 ml-4 space-y-0.5 border-l border-vault-border pl-2">
          {sections.map((section) => {
            const sectionHref =
              group === "vault"
                ? `/vault/category/${section.slug}`
                : `/gear/${section.slug}`;
            return (
              <Link
                key={section.slug}
                href={sectionHref}
                onClick={() => onNavigate?.()}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                  pathname === sectionHref
                    ? "text-[#00C2FF]"
                    : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{section.label}</span>
                <span className="shrink-0 tabular-nums text-vault-text-faint">
                  {counts[section.slug] ?? 0}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface SidebarProps {
  mobileOnly?: boolean;
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

export function Sidebar({
  mobileOnly = false,
  mobileOpen = false,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(pathname.startsWith("/range"));
  const isRangeRoute = pathname.startsWith("/range");
  const rangeSectionOpen = isRangeRoute || rangeOpen;
  const [counts, setCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    onMobileClose?.();
  }, [pathname, onMobileClose]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories/counts")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body?.counts) setCounts(body.counts);
      })
      .catch(() => {
        // A missing count shows as blank; the nav still works.
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMobileClose?.();
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [mobileOpen, onMobileClose]);

  const navContent = (
    <>
      <div className="flex items-center gap-3 px-4 h-14 border-b border-vault-border shrink-0">
        <div className="w-7 h-7 rounded bg-[#00C2FF]/10 border border-[#00C2FF]/30 flex items-center justify-center shrink-0">
          <Shield className="w-4 h-4 text-[#00C2FF]" />
        </div>
        {!collapsed && (
          <div className="overflow-hidden flex-1 min-w-0">
            <p className="text-xs font-bold text-vault-text tracking-widest uppercase leading-none">
              BlackVault
            </p>
            <p className="text-[10px] text-vault-text-faint tracking-wider uppercase mt-0.5">
              Armory Platform
            </p>
          </div>
        )}
        {onMobileClose && (
          <button
            onClick={onMobileClose}
            className="md:hidden ml-auto p-1 text-vault-text-faint hover:text-vault-text-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto overscroll-contain py-3 space-y-0.5 px-2 pb-6">
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("bv:search:open"))
          }
          className={cn(
            "flex items-center gap-2 w-full px-3 py-2 rounded-md text-vault-text-faint hover:text-vault-text hover:bg-vault-border/40 transition-colors text-sm mb-1",
            collapsed ? "justify-center" : "",
          )}
          title={collapsed ? "Search" : undefined}
        >
          <Search className="w-4 h-4 shrink-0" />
          {!collapsed && <span>Search</span>}
        </button>
        {!collapsed && (
          <p className="px-2.5 pb-2 text-[10px] tracking-[0.18em] uppercase text-vault-text-faint">
            Navigation
          </p>
        )}

        {PRIMARY_NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => onMobileClose?.()}
              title={collapsed ? item.label : undefined}
              className={cn(
                "flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-all duration-150 group relative",
                isActive
                  ? "bg-[#00C2FF]/10 text-[#00C2FF] border border-[#00C2FF]/20"
                  : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[#00C2FF] rounded-r-full" />
              )}
              <Icon
                className={cn(
                  "shrink-0 transition-colors",
                  collapsed ? "w-5 h-5" : "w-4 h-4",
                  isActive
                    ? "text-[#00C2FF]"
                    : "text-vault-text-faint group-hover:text-vault-text-muted",
                )}
              />
              {!collapsed && (
                <span className="min-w-0">
                  <span className="block font-medium tracking-wide truncate">
                    {item.label}
                  </span>
                  <span className="block text-[11px] text-vault-text-faint truncate">
                    {item.description}
                  </span>
                </span>
              )}
            </Link>
          );
        })}

        <NavGroup
          label="Vault"
          description="Firearms inventory"
          href="/vault"
          icon={Shield}
          group="vault"
          pathname={pathname}
          collapsed={collapsed}
          counts={counts}
          onNavigate={onMobileClose}
        />
        <NavGroup
          label="Gear"
          description="Optics, parts & more"
          href="/gear"
          icon={Crosshair}
          group="gear"
          pathname={pathname}
          collapsed={collapsed}
          counts={counts}
          onNavigate={onMobileClose}
        />

        <div>
          <button
            onClick={() => setRangeOpen((prev) => !prev)}
            className={cn(
              "w-full flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-all duration-150 group relative",
              isRangeRoute
                ? "bg-[#00C2FF]/10 text-[#00C2FF] border border-[#00C2FF]/20"
                : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
            )}
            title={collapsed ? "Range" : undefined}
          >
            {isRangeRoute && (
              <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[#00C2FF] rounded-r-full" />
            )}
            <Target
              className={cn(
                "shrink-0 transition-colors",
                collapsed ? "w-5 h-5" : "w-4 h-4",
                isRangeRoute
                  ? "text-[#00C2FF]"
                  : "text-vault-text-faint group-hover:text-vault-text-muted",
              )}
            />
            {!collapsed && (
              <>
                <span className="min-w-0 text-left">
                  <span className="block font-medium tracking-wide truncate">
                    Range
                  </span>
                  <span className="block text-[11px] text-vault-text-faint truncate">
                    Sessions & drills
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "w-4 h-4 ml-auto transition-transform",
                    rangeSectionOpen ? "rotate-180" : "rotate-0",
                  )}
                />
              </>
            )}
          </button>

          {!collapsed && rangeSectionOpen && (
            <div className="mt-1 ml-4 border-l border-vault-border pl-2 space-y-0.5">
              {RANGE_CHILD_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => onMobileClose?.()}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-vault-text-muted hover:text-vault-text hover:bg-vault-border transition-colors"
                  >
                    <Icon className="w-3.5 h-3.5 text-vault-text-faint" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="pt-2 mt-2 border-t border-vault-border/70">
          {BOTTOM_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => onMobileClose?.()}
                title={collapsed ? item.label : undefined}
                className={cn(
                  "flex items-center gap-3 px-2.5 py-2 rounded-md text-sm transition-all duration-150 group relative",
                  isActive
                    ? "bg-[#00C2FF]/10 text-[#00C2FF] border border-[#00C2FF]/20"
                    : "text-vault-text-muted hover:text-vault-text hover:bg-vault-border",
                )}
              >
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[#00C2FF] rounded-r-full" />
                )}
                <Icon
                  className={cn(
                    "shrink-0 transition-colors",
                    collapsed ? "w-5 h-5" : "w-4 h-4",
                    isActive
                      ? "text-[#00C2FF]"
                      : "text-vault-text-faint group-hover:text-vault-text-muted",
                  )}
                />
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block font-medium tracking-wide truncate">
                      {item.label}
                    </span>
                    <span className="block text-[11px] text-vault-text-faint truncate">
                      {item.description}
                    </span>
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </nav>

      <div className="px-2 pb-3 shrink-0 border-t border-vault-border pt-2 space-y-1.5">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="hidden md:flex w-full items-center justify-center gap-2 px-2.5 py-2 rounded-md text-vault-text-faint hover:text-vault-text-muted hover:bg-vault-border transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4" />
          ) : (
            <>
              <ChevronLeft className="w-4 h-4" />
              <span className="text-xs tracking-wider uppercase">Collapse</span>
            </>
          )}
        </button>
      </div>
    </>
  );

  return (
    <>
      {!mobileOnly && (
        <aside
          className={cn(
            "hidden md:flex flex-col h-svh border-r border-vault-border bg-vault-surface transition-all duration-300 ease-in-out shrink-0",
            collapsed ? "w-16" : "w-56",
          )}
        >
          {navContent}
        </aside>
      )}

      <div
        className={cn(
          "fixed inset-0 z-[420] md:hidden transition-opacity",
          mobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
        aria-hidden={!mobileOpen}
      >
        <div className="absolute inset-0 bg-black/60" onClick={onMobileClose} />
        <aside
          id="mobile-navigation"
          className={cn(
            "absolute inset-y-0 left-0 flex h-svh max-h-svh w-72 max-w-[88vw] flex-col overflow-hidden border-r border-vault-border bg-vault-surface shadow-2xl transition-transform duration-200",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {navContent}
        </aside>
      </div>
    </>
  );
}
