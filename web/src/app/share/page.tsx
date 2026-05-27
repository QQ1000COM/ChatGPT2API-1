"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LoaderCircle } from "lucide-react";

import { fetchImageShare } from "@/lib/api";

type ShareItem = {
  token: string;
  image_rel: string;
  image_url: string;
  title: string;
  prompt: string;
};

export default function SharePage() {
  const params = useSearchParams();
  const token = params.get("token") || "";
  const [item, setItem] = useState<ShareItem | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("分享链接缺少 token");
      return;
    }
    let active = true;
    void fetchImageShare(token)
      .then((data) => {
        if (!active) return;
        setItem(data.item);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "分享不存在或已失效");
      });
    return () => {
      active = false;
    };
  }, [token]);

  if (error) {
    return <main className="grid min-h-screen place-items-center px-4 text-sm text-muted-foreground">{error}</main>;
  }

  if (!item) {
    return <main className="grid min-h-screen place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></main>;
  }

  const imageUrl = item.image_url || (item.image_rel ? `/images/${item.image_rel}` : "");

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-5xl gap-5 px-4 py-8 md:grid-cols-[1fr_320px]">
      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {imageUrl ? <img src={imageUrl} alt={item.title} className="h-full w-full object-contain" /> : null}
      </section>
      <aside className="h-fit rounded-2xl border border-border bg-card p-5 shadow-sm">
        <div className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">Share</div>
        <h1 className="mt-2 text-xl font-black">{item.title || "图片分享"}</h1>
        {item.prompt ? <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.prompt}</p> : null}
      </aside>
    </main>
  );
}
