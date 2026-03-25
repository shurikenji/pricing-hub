"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Model Pricing", icon: "Pricing" },
  { href: "/logs", label: "Usage Logs", icon: "Logs" },
  { href: "/keys", label: "Key Manager", icon: "Keys" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sidebar">
      <div className="sidebar-logo">
        <span>PH</span> Pricing Hub
      </div>
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`nav-link${pathname === link.href ? " active" : ""}`}
        >
          <span>{link.icon}</span>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
