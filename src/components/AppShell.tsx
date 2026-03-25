"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { Nav } from "@/components/Nav";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAdminPath = pathname.startsWith("/control") || pathname.startsWith("/admin");

  if (isAdminPath) {
    return <main className="main-content main-content-full">{children}</main>;
  }

  return (
    <div className="app-layout">
      <Nav />
      <main className="main-content">{children}</main>
    </div>
  );
}
