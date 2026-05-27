"use client";

import { useEffect, useState } from "react";
import { Copy, LoaderCircle, MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createQQBindUrl, fetchMyProfile, type MyProfile } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

export default function ProfilePage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [data, setData] = useState<MyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBinding, setIsBinding] = useState(false);

  const load = async () => {
    setIsLoading(true);
    try {
      const next = await fetchMyProfile();
      setData(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载个人中心失败");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!session) return;
    void load();
  }, [session]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("qq_bind");
    if (!status) return;
    if (status === "success") {
      toast.success("QQ 已授权绑定");
    } else {
      toast.error(params.get("message") || "QQ 授权绑定失败");
    }
    params.delete("qq_bind");
    params.delete("message");
    const nextSearch = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
  }, []);

  const bindQQ = async () => {
    setIsBinding(true);
    try {
      const response = await createQQBindUrl();
      window.location.href = response.authorize_url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 QQ 授权链接失败");
      setIsBinding(false);
    }
  };

  const maskQQ = (value: string | undefined) => {
    const normalized = String(value || "").trim();
    if (!normalized) return "";
    if (normalized.length <= 10) return normalized;
    return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
  };

  const formatBoundAt = (value: string | null | undefined) => {
    if (!value) return "";
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  if (isCheckingAuth || !session || isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const profile = data?.profile;
  const unlimited = Boolean(profile?.unlimited);
  const remaining = unlimited ? "不限" : String(profile?.remaining ?? 0);
  const quota = unlimited ? "不限" : String(profile?.quota ?? 0);
  const used = profile?.used ?? 0;
  const qqValue = maskQQ(profile?.qq);
  const inviteLink = typeof window !== "undefined" && profile?.id ? `${window.location.origin}/login?invite=${encodeURIComponent(profile.id)}` : "";

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-foreground">个人中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">查看额度、绑定 QQ、管理自己的生图记录。</p>
        </div>
        <Button type="button" variant="outline" className="rounded-full" onClick={() => void load()}>
          <RefreshCw className="size-4" />
          刷新
        </Button>
      </div>

      <section className="grid gap-3 md:grid-cols-4">
        {[
          ["账号名称", profile?.name || session.name || "-"],
          ["剩余生图数量", remaining],
          ["已生图数量", String(used)],
          ["总额度", quota],
        ].map(([label, value]) => (
          <div key={label} className="rounded-2xl border border-border bg-card p-4 shadow-sm">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 truncate text-2xl font-black text-foreground">{value}</div>
          </div>
        ))}
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">QQ 绑定</div>
            <div className="mt-1 text-xs text-muted-foreground">当前回调地址：{data?.qq_callback_url || "-"}</div>
          </div>
          <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
            {profile?.qq ? "已绑定" : "未绑定"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" className="rounded-full bg-[#12b7f5] px-5 text-white hover:bg-[#0aa7e2]" onClick={() => void bindQQ()} disabled={isBinding || !data?.qq_oauth_enabled}>
            {isBinding ? <LoaderCircle className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
            {profile?.qq ? "重新授权 QQ" : "使用 QQ 登录绑定"}
          </Button>
          {profile?.qq ? (
            <div className="text-xs text-muted-foreground">
              已绑定：{qqValue}
              {profile.qq_bound_at ? `，${formatBoundAt(profile.qq_bound_at)}` : ""}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              {data?.qq_oauth_enabled ? "点击 QQ 图标跳转 QQ 互联授权，授权成功后自动绑定。" : "后台未配置 QQ APP ID 或 APP Key。"}
            </div>
          )}
        </div>
      </section>

      {profile?.role === "user" ? (
        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3">
            <div className="text-sm font-semibold">邀请返额度</div>
            <div className="mt-1 text-xs text-muted-foreground">好友通过你的链接首次 QQ 登录注册后，你会获得后台设置的奖励额度。</div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input readOnly value={inviteLink} className="h-10 flex-1 rounded-xl border border-input bg-background px-3 text-sm outline-none" />
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              onClick={() => {
                void navigator.clipboard.writeText(inviteLink);
                toast.success("邀请链接已复制");
              }}
            >
              <Copy className="size-4" />
              复制链接
            </Button>
          </div>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-semibold">生图记录</div>
          <div className="mt-1 text-xs text-muted-foreground">共 {data?.image_count || 0} 张，最近最多显示 60 张。</div>
        </div>
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {(data?.images || []).length === 0 ? (
            <div className="col-span-full grid min-h-48 place-items-center text-sm text-muted-foreground">暂无生图记录</div>
          ) : (
            (data?.images || []).map((image) => (
              <a key={image.rel} href={image.url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-xl border border-border bg-background">
                <div className="aspect-square bg-muted">
                  <img src={image.thumbnail_url || image.url} alt={image.name} className="h-full w-full object-cover" />
                </div>
                <div className="space-y-1 p-2">
                  <div className="truncate text-xs font-semibold">{image.name}</div>
                  <div className="text-[11px] text-muted-foreground">{image.created_at}</div>
                </div>
              </a>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
