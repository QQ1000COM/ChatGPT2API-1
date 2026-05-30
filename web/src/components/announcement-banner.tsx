"use client";

import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

import { fetchPublicConfig } from "@/lib/api";
import { sanitizeAnnouncementHtml } from "@/lib/html";

export function AnnouncementBanner() {
  const pathname = usePathname();
  const [html, setHtml] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [dismissedKey, setDismissedKey] = useState("");

  useEffect(() => {
    if (pathname === "/login") {
      return;
    }
    let active = true;
    fetchPublicConfig()
      .then((data) => {
        if (!active) return;
        setEnabled(Boolean(data.announcement_enabled));
        setHtml(String(data.announcement_html || ""));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [pathname]);

  const safeHtml = useMemo(() => sanitizeAnnouncementHtml(html), [html]);
  const storageKey = useMemo(() => `chatgpt2api:announcement:${safeHtml}`, [safeHtml]);

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    setDismissedKey(localStorage.getItem(storageKey) === "1" ? storageKey : "");
  }, [storageKey]);

  if (!enabled || !safeHtml || dismissedKey === storageKey) {
    return null;
  }

  return (
    <div className="mx-auto mt-3 flex max-w-[1440px] items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 shadow-sm">
      <div className="min-w-0 flex-1 announcement-html" dangerouslySetInnerHTML={{ __html: safeHtml }} />
      <button
        type="button"
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-amber-900 transition hover:bg-amber-100"
        aria-label="关闭公告"
        onClick={() => {
          localStorage.setItem(storageKey, "1");
          setDismissedKey(storageKey);
        }}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

