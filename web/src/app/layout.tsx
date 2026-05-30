import type { Metadata, Viewport } from "next";
import { Toaster } from "sonner";
import "./globals.css";
import { PageTransition } from "@/components/page-transition";
import { RouteProgress } from "@/components/route-progress";
import { TitleSync } from "@/components/title-sync";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { TopNav } from "@/components/top-nav";

export const metadata: Metadata = {
  title: "QQ1000 AI",
  description: "QQ1000 AI 电商图片生成工作台",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#fbfbfd",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body
        className="antialiased font-sans"
        style={{
          fontFamily:
            'var(--font-sans), "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif',
        }}
      >
        <Toaster position="top-center" richColors offset={48} />
        <TitleSync />
        <RouteProgress />
        <TopNav />
        <main className="h-screen overflow-x-hidden overflow-y-auto px-4 pt-12 pb-2 text-foreground [scrollbar-gutter:stable_both-edges] sm:px-6 sm:pt-14 lg:px-8">
          <div className="mx-auto box-border flex max-w-[1440px] flex-col pt-[env(safe-area-inset-top)]">
            <AnnouncementBanner />
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </body>
    </html>
  );
}
