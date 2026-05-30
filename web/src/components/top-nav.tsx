"use client";

import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { clearAuthSessionCache, getValidatedAuthSession } from "@/lib/auth-session";
import { fetchMyProfile, fetchOnboarding, fetchPublicConfig, saveOnboarding } from "@/lib/api";
import { cn } from "@/lib/utils";
import { clearStoredAuthSession, type StoredAuthSession } from "@/store/auth";

const adminNavItems = [
  { href: "/image", label: "画图" },
  { href: "/detail-page", label: "电商工具箱" },
  { href: "/task-center", label: "任务中心" },
  { href: "/gallery", label: "画廊" },
  { href: "/accounts", label: "号池管理" },
  { href: "/register", label: "注册机" },
  { href: "/image-manager", label: "图片管理" },
  { href: "/profile", label: "个人中心" },
  { href: "/settings", label: "设置" },
];

const userNavItems = [
  { href: "/image", label: "画图" },
  { href: "/detail-page", label: "电商工具箱" },
  { href: "/task-center", label: "任务中心" },
  { href: "/works", label: "我的作品" },
  { href: "/gallery", label: "画廊" },
  { href: "/profile", label: "个人中心" },
];

// next.config.ts 配了 trailingSlash: true，usePathname 返回 "/image/"，
// nav item 的 href 是 "/image"，直接 === 永远不命中。统一抹掉尾斜杠再比。
function normalizePath(value: string) {
  if (!value) return "/";
  const trimmed = value.replace(/\/+$/, "");
  return trimmed || "/";
}

type Rect = { left: number; width: number };

export function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<StoredAuthSession | null | undefined>(undefined);
  const [siteName, setSiteName] = useState("ChatGPT2API");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [quotaLabel, setQuotaLabel] = useState("0");

  useEffect(() => {
    let active = true;

    const load = async () => {
      if (pathname === "/login") {
        if (!active) {
          return;
        }
        setSession(null);
        return;
      }

      const storedSession = await getValidatedAuthSession();
      if (!active) {
        return;
      }
      setSession(storedSession);
    };

    void load();
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (pathname === "/login") return;
    let active = true;
    fetchPublicConfig()
      .then((data) => {
        if (active) {
          setSiteName(String(data.site_name || "ChatGPT2API"));
          document.title = String(data.browser_title || data.site_name || "ChatGPT2API");
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [pathname]);

  useEffect(() => {
    if (!session || pathname === "/login") return;
    let active = true;
    Promise.all([fetchOnboarding(), fetchMyProfile().catch(() => null)])
      .then(([state, profile]) => {
        if (!active) return;
        if (!state.state.dismissed) {
          const p = profile?.profile;
          setQuotaLabel(p?.unlimited ? "不限" : String(p?.remaining ?? 0));
          setShowOnboarding(true);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [session, pathname]);

  const finishOnboarding = async () => {
    setShowOnboarding(false);
    await saveOnboarding(true).catch(() => undefined);
    router.push("/detail-page");
  };

  const handleLogout = async () => {
    await clearStoredAuthSession();
    clearAuthSessionCache();
    router.replace("/login");
  };

  useEffect(() => {
    if (!session || pathname === "/login") return;
    const routes = session.role === "admin"
      ? ["/chat", "/image", "/detail-page", "/task-center", "/gallery", "/image-manager", "/settings"]
      : ["/chat", "/image", "/detail-page", "/task-center", "/works", "/gallery", "/profile"];
    const timer = window.setTimeout(() => {
      routes.forEach((route) => router.prefetch(route));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [pathname, router, session]);

  // 一根"会滑动的下划线"：默认贴在当前页那项下面，hover 哪项就滑到哪项，
  // 鼠标离开整条 nav 后回到 active 项。Vercel / Linear / Apple 同套路。
  const navRef = useRef<HTMLElement | null>(null);
  const itemRefs = useRef<Map<string, HTMLAnchorElement | null>>(new Map());
  const [activeRect, setActiveRect] = useState<Rect | null>(null);
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  // 第一次还没测过位置时不要做 transition，避免下划线从 (0,0) "飞"过来。
  const hasInitialPositionRef = useRef(false);
  const [enableTransition, setEnableTransition] = useState(false);

  const measure = (href: string): Rect | null => {
    const anchor = itemRefs.current.get(href);
    const nav = navRef.current;
    if (!anchor || !nav) return null;
    const navRect = nav.getBoundingClientRect();
    const rect = anchor.getBoundingClientRect();
    return {
      left: rect.left - navRect.left,
      width: rect.width,
    };
  };

  useEffect(() => {
    if (!session) {
      setActiveRect(null);
      hasInitialPositionRef.current = false;
      setEnableTransition(false);
      return;
    }
    const items = session.role === "admin" ? adminNavItems : userNavItems;
    const activeItem = items.find(
      (item) => normalizePath(item.href) === normalizePath(pathname || "/"),
    );
    if (!activeItem) {
      setActiveRect(null);
      return;
    }
    let raf = 0;
    const update = () => {
      const r = measure(activeItem.href);
      if (!r) return;
      setActiveRect(r);
      // 第一次定位完成后，下一帧再开 transition，
      // 这样初始落点直接 snap，不会有从 0 滑过来的拖影。
      if (!hasInitialPositionRef.current) {
        hasInitialPositionRef.current = true;
        requestAnimationFrame(() => setEnableTransition(true));
      }
    };
    raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
    };
  }, [pathname, session]);

  if (pathname === "/login" || session === undefined || !session) {
    return null;
  }

  const navItems = session.role === "admin" ? adminNavItems : userNavItems;
  // 只有一个标签时（普通用户只能进画图）就别渲染导航条了，
  // 单独一个"画图"挂在中间反而像 placeholder，logo 已经指向 /image 够用了。
  const showNav = navItems.length > 1;
  const roleLabel = session.role === "admin" ? "管理员" : "普通用户";
  const displayName = session.name.trim() || roleLabel;

  // 下划线最终位置：hover 时跟 hover，否则跟 active。两段 padding 内缩 8px，
  // 让线条比文字略短一点，更精致。
  const target = hoverRect ?? activeRect;
  const showIndicator = !!target;
  const indicatorLeft = target ? target.left + 8 : 0;
  const indicatorWidth = target ? Math.max(0, target.width - 16) : 0;

  return (
    <>
    <header className="fixed top-0 right-0 left-0 z-40 bg-background/25 backdrop-blur-[28px] backdrop-saturate-150">
      <div className="mx-auto flex h-12 max-w-[1440px] items-center gap-3 px-4 sm:h-14 sm:gap-4 sm:px-6 lg:px-8">
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <Link href="/image" className="group flex shrink-0 -translate-y-[1px] items-center py-1">
            <span className="max-w-[220px] truncate text-[20px] font-bold leading-none tracking-[-0.025em] text-foreground">
              {siteName || "ChatGPT2API"}
            </span>
          </Link>
        </div>
        {showNav ? (
        <nav
          ref={navRef}
          className="hide-scrollbar relative -mx-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 sm:justify-center sm:gap-0.5 sm:overflow-visible sm:px-0"
          onMouseLeave={() => setHoverRect(null)}
        >
          {navItems.map((item) => {
            const active = normalizePath(item.href) === normalizePath(pathname || "/");
            return (
              <Link
                key={item.href}
                ref={(el) => {
                  if (el) itemRefs.current.set(item.href, el);
                  else itemRefs.current.delete(item.href);
                }}
                href={item.href}
                onMouseEnter={() => {
                  router.prefetch(item.href);
                  const r = measure(item.href);
                  if (r) setHoverRect(r);
                }}
                onFocus={() => router.prefetch(item.href)}
                className={cn(
                  "relative shrink-0 cursor-pointer whitespace-nowrap px-3 py-1.5 text-[13px] font-medium leading-none transition-colors duration-200",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
          {/* 单根滑动下划线：跟着 hover/active 平移。
              用 transform + width 触发 GPU 合成，不用 left；
              曲线 cubic-bezier(0.32, 0.72, 0, 1) 是 Apple 系常用的"重物缓出"，
              比线性 ease-out 更"丝滑"，看起来像被吸过去的。 */}
          <span
            aria-hidden
            className="pointer-events-none absolute h-[2px] rounded-full bg-foreground"
            style={{
              left: 0,
              bottom: -9,
              width: indicatorWidth,
              transform: `translateX(${indicatorLeft}px)`,
              opacity: showIndicator ? 1 : 0,
              transition: enableTransition
                ? "transform 380ms cubic-bezier(0.32, 0.72, 0, 1), width 380ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease-out"
                : "opacity 200ms ease-out",
              willChange: "transform, width",
            }}
          />
        </nav>
        ) : (
          <div className="min-w-0 flex-1" aria-hidden />
        )}
        <div className="flex shrink-0 items-center justify-end gap-2">
          <Link
            href="/chat"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-md border border-border/70 bg-card text-muted-foreground transition hover:bg-accent hover:text-foreground",
              normalizePath(pathname || "/") === "/chat" && "border-foreground/20 text-foreground",
            )}
            aria-label="AI 对话"
            title="AI 对话"
            onMouseEnter={() => router.prefetch("/chat")}
            onFocus={() => router.prefetch("/chat")}
          >
            <MessageCircle className="size-4" />
          </Link>
          <span className="hidden items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-1 text-[11px] leading-none text-muted-foreground lg:inline-flex">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
            <span className="font-data text-[10.5px] font-bold uppercase tracking-wider">Online</span>
          </span>
          <span className="hidden items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-1 text-[11px] leading-none md:inline-flex">
            <span className="grid size-4 place-items-center rounded-[4px] bg-foreground text-[8px] font-bold text-background">
              {(displayName[0] || roleLabel[0] || "U").toUpperCase()}
            </span>
            <span className="hidden font-data font-bold text-foreground lg:inline">{displayName}</span>
            {displayName !== roleLabel ? (
              <>
                <span className="hidden text-muted-foreground/70 lg:inline">·</span>
                <span className="hidden font-bold text-muted-foreground lg:inline">{roleLabel}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            className="cursor-pointer rounded-md border border-transparent px-2 py-1 text-[13px] font-bold leading-none text-muted-foreground transition hover:border-border/70 hover:bg-card hover:text-foreground"
            onClick={() => void handleLogout()}
          >
            退出
          </button>
        </div>
      </div>
    </header>
    {showOnboarding ? (
      <div className="fixed inset-0 z-50 grid place-items-center bg-background/70 px-4 backdrop-blur-sm">
        <div className="w-full max-w-lg rounded-3xl border border-border bg-card p-6 shadow-2xl">
          <div className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">Welcome</div>
          <h2 className="mt-2 text-2xl font-black">3 步开始生成电商图片</h2>
          <div className="mt-5 grid gap-3">
            {["上传商品图", "选择主图/买家秀/详情页场景", `领取/查看额度：${quotaLabel} 张`].map((item, index) => (
              <div key={item} className="flex items-center gap-3 rounded-2xl border border-border bg-background p-3">
                <span className="grid size-8 place-items-center rounded-full bg-foreground text-sm font-black text-background">{index + 1}</span>
                <span className="text-sm font-semibold">{item}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row">
            <button type="button" className="h-11 flex-1 rounded-xl bg-foreground px-4 text-sm font-bold text-background" onClick={() => void finishOnboarding()}>
              开始生成
            </button>
            <button type="button" className="h-11 rounded-xl border border-border px-4 text-sm font-bold" onClick={() => { setShowOnboarding(false); void saveOnboarding(true); }}>
              稍后再看
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}
