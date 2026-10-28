"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Scanner" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/paper-trading", label: "Paper Trading" },
  { href: "/analytics", label: "Analytics" },
  { href: "/strategy", label: "Strategy" },
  { href: "/settings", label: "Settings" },
] as const;

export default function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 md:px-6">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <span className="text-sm font-bold tracking-tight text-slate-100 transition-colors group-hover:text-white">
            Market Scanner
          </span>
          <span className="hidden rounded-full border border-slate-700 bg-slate-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 md:inline-block">
            Live EV
          </span>
        </Link>

        <nav className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto px-1 sm:mx-0 sm:px-0">
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                  active
                    ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                    : "border-transparent text-slate-400 hover:bg-slate-800/80 hover:text-slate-100",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
