"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock3, LoaderCircle, RefreshCw, XCircle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { fetchImageTasks, rerunImageTask, type ImageTask } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const statusMap = {
  queued: { label: "排队中", icon: Clock3, className: "bg-amber-50 text-amber-700" },
  running: { label: "生成中", icon: LoaderCircle, className: "bg-sky-50 text-sky-700" },
  success: { label: "已完成", icon: CheckCircle2, className: "bg-emerald-50 text-emerald-700" },
  error: { label: "失败", icon: XCircle, className: "bg-rose-50 text-rose-700" },
  canceled: { label: "已取消", icon: XCircle, className: "bg-stone-100 text-stone-500" },
} as const;

export default function TaskCenterPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [items, setItems] = useState<ImageTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = async (showLoading = true) => {
    if (showLoading) {
      setIsLoading(true);
    }
    try {
      const data = await fetchImageTasks([]);
      setItems(data.items || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载任务失败");
    } finally {
      if (showLoading) {
        setIsLoading(false);
      }
    }
  };

  const rerun = async (id: string) => {
    try {
      await rerunImageTask(id);
      toast.success("已提交重新生成");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重新生成失败");
    }
  };

  useEffect(() => {
    if (!session) return;
    void load();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const hasActiveTasks = items.some((item) => item.status === "running" || item.status === "queued");
    if (!hasActiveTasks) return;
    const timer = window.setInterval(() => {
      void load(false);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [items, session]);

  const stats = useMemo(() => ({
    total: items.length,
    running: items.filter((item) => item.status === "running" || item.status === "queued").length,
    success: items.filter((item) => item.status === "success").length,
    failed: items.filter((item) => item.status === "error").length,
  }), [items]);

  if (isCheckingAuth || !session) {
    return <div className="grid min-h-[50vh] place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">Task Center</div>
          <h1 className="mt-2 text-2xl font-black text-foreground">任务中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">集中查看排队、生成中、失败和完成的生图任务。</p>
        </div>
        <Button type="button" variant="outline" className="rounded-full" onClick={() => void load()} disabled={isLoading}>
          {isLoading ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          刷新
        </Button>
      </div>

      <section className="grid gap-3 md:grid-cols-4">
        {[["全部任务", stats.total], ["进行中", stats.running], ["已完成", stats.success], ["失败", stats.failed]].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-black">{value}</div>
          </div>
        ))}
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {items.length === 0 ? (
          <div className="grid min-h-56 place-items-center text-sm text-muted-foreground">暂无任务记录</div>
        ) : (
          <div className="divide-y divide-border">
            {items.map((item) => {
              const meta = statusMap[item.status] || statusMap.queued;
              const Icon = meta.icon;
              return (
                <div key={item.id} className="grid gap-3 p-4 md:grid-cols-[160px_1fr_180px_120px] md:items-center">
                  <span className={`inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${meta.className}`}>
                    <Icon className={`size-3.5 ${item.status === "running" ? "animate-spin" : ""}`} />
                    {meta.label}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{item.model || "图片任务"} · {item.size || "默认尺寸"}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground">{item.error || item.prompt || item.id}</div>
                    {Number(item.retry_count || 0) > 0 ? <div className="mt-1 text-[11px] text-amber-600">已自动重试 {item.retry_count} 次</div> : null}
                  </div>
                  <div className="text-xs text-muted-foreground md:text-right">{item.updated_at || item.created_at}</div>
                  <div className="md:text-right">
                    {item.status === "error" && item.mode === "generate" ? (
                      <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={() => void rerun(item.id)}>
                        重新生成
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
