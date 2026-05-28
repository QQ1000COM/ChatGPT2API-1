"use client";

import { useEffect } from "react";

import { fetchPublicConfig } from "@/lib/api";

const FALLBACK_TITLE = "QQ1000 AI";

export function TitleSync() {
  useEffect(() => {
    let active = true;
    void fetchPublicConfig()
      .then((data) => {
        if (!active) return;
        document.title = String(data.browser_title || data.site_name || FALLBACK_TITLE);
      })
      .catch(() => {
        if (active && !document.title) {
          document.title = FALLBACK_TITLE;
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return null;
}
