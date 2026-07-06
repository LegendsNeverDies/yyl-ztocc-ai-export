"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Upload, Settings, ListOrdered, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "导入下单", icon: Upload },
  { href: "/rules", label: "规则管理", icon: Settings },
  { href: "/orders", label: "运单列表", icon: ListOrdered },
];

export function SideBar() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {/* 桌面端：左侧固定侧边栏 */}
      <aside className="fixed left-0 top-0 z-50 hidden h-full w-[224px] flex-col bg-[#0fc6c2] shadow-[4px_0_16px_rgba(0,0,0,0.08)] lg:flex">
        <Link href="/" className="flex items-center gap-2 px-6 py-5 text-white no-underline">
          <Sparkles className="h-7 w-7 flex-shrink-0" />
          <span className="text-lg font-bold tracking-wide">万能导入 V2</span>
        </Link>
        <div className="mx-6 mb-2 h-px bg-white/20" />
        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-4 py-2.5 text-sm font-medium transition-all no-underline",
                  active
                    ? "bg-white/25 text-white shadow-sm"
                    : "text-white/80 hover:bg-white/10 hover:text-white"
                )}
              >
                <Icon className="h-5 w-5 flex-shrink-0" />
                <span>{item.label}</span>
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-white" />}
              </Link>
            );
          })}
        </nav>
        <div className="px-6 py-4 text-xs leading-relaxed text-white/60">
          智能多格式批量下单
          <br />AI 自动解析 · 一键提交
        </div>
      </aside>

      {/* 移动端：顶部窄横条 */}
      <nav className="fixed left-0 right-0 top-0 z-50 flex h-14 items-center justify-between bg-[#0fc6c2] px-4 shadow-md lg:hidden">
        <Link href="/" className="flex items-center gap-2 text-white no-underline">
          <Sparkles className="h-6 w-6 flex-shrink-0" />
          <span className="text-base font-bold">万能导入 V2</span>
        </Link>
        <div className="flex items-center gap-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium no-underline",
                  active ? "bg-white/20 text-white" : "text-white/80 hover:bg-white/10"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
