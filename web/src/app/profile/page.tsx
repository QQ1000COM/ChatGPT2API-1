"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronDown, Code2, Copy, DollarSign, Download, FileText, Folder, KeyRound, LoaderCircle, Maximize2, MessageCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { ImageLightbox } from "@/components/image-lightbox";
import { Button } from "@/components/ui/button";
import { createQQBindUrl, downloadImages, fetchMyProfile, type MyProfile } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

type ProfileImage = MyProfile["images"][number];
type ProfileEntry =
  | { type: "image"; id: string; item: ProfileImage }
  | { type: "folder"; id: string; title: string; count: number; items: ProfileImage[] };

function detailText(item: NonNullable<MyProfile["codex_logs"]>[number], key: string) {
  const value = item.detail?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "-";
}

function detailNumber(item: NonNullable<MyProfile["codex_logs"]>[number], key: string) {
  const value = item.detail?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compactToken(value: number | null) {
  if (value === null) return "-";
  if (value >= 100_000) return `${(value / 1000).toFixed(1)}K`;
  if (value >= 1000) return `${(value / 1000).toFixed(2)}K`;
  return String(Math.round(value));
}

function compactUsd(value: number | null) {
  if (value === null) return "-";
  return `$${value.toFixed(5)}`;
}

function logStatus(item: NonNullable<MyProfile["codex_logs"]>[number]) {
  const status = item.detail?.status;
  if (status === "failed") return "失败";
  if (status === "success") return "成功";
  return "-";
}

function groupProfileImages(images: ProfileImage[]): ProfileEntry[] {
  const groups = new Map<string, ProfileImage[]>();
  const order: string[] = [];
  for (const image of images) {
    const key = image.group_id && (image.group_count || 0) > 1 ? image.group_id : "";
    if (!key) {
      order.push(`image:${image.rel}`);
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(`group:${key}`);
    }
    groups.get(key)?.push(image);
  }
  return order.map((key) => {
    if (key.startsWith("group:")) {
      const id = key.slice("group:".length);
      const items = (groups.get(id) || []).sort((a, b) => (a.group_index ?? 0) - (b.group_index ?? 0));
      return {
        type: "folder",
        id,
        title: items[0]?.group_title || "成套图片",
        count: items[0]?.group_count || items.length,
        items,
      };
    }
    const rel = key.slice("image:".length);
    const item = images.find((image) => image.rel === rel) || images[0];
    return { type: "image", id: rel, item };
  });
}

export default function ProfilePage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [data, setData] = useState<MyProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isBinding, setIsBinding] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<Array<{ id: string; src: string; sizeLabel?: string; dimensions?: string }>>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [codexLogsOpen, setCodexLogsOpen] = useState(false);

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
      return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    } catch {
      return value;
    }
  };

  const formatNumber = (value: number | undefined) => (value || 0).toLocaleString();
  const formatUsd = (value: number | undefined) => `$${(value || 0).toFixed(6)}`;
  const maskKey = (value: string | undefined) => {
    const normalized = String(value || "").trim();
    if (!normalized) return "-";
    if (normalized.length <= 12) return `${normalized.slice(0, 3)}***${normalized.slice(-2)}`;
    return `${normalized.slice(0, 7)}...${normalized.slice(-4)}`;
  };

  const copyText = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.error("澶嶅埗澶辫触");
    }
  };

  const imageEntries = useMemo(() => groupProfileImages(data?.images || []), [data?.images]);
  const allLightboxImages = useMemo(
    () =>
      (data?.images || []).map((image) => ({
        id: image.rel,
        src: image.url,
        sizeLabel: image.size ? `${(image.size / 1024 / 1024).toFixed(2)} MB` : undefined,
        dimensions: image.width && image.height ? `${image.width} x ${image.height}` : undefined,
      })),
    [data?.images],
  );

  const openImages = (images: ProfileImage[], index: number) => {
    const items = images.map((image) => ({
      id: image.rel,
      src: image.url,
      sizeLabel: image.size ? `${(image.size / 1024 / 1024).toFixed(2)} MB` : undefined,
      dimensions: image.width && image.height ? `${image.width} x ${image.height}` : undefined,
    }));
    setLightboxImages(items);
    setLightboxIndex(Math.max(0, Math.min(index, items.length - 1)));
    setLightboxOpen(items.length > 0);
  };

  const downloadPaths = async (paths: string[], filename = "images.zip") => {
    if (paths.length === 0) return;
    setIsDownloading(true);
    try {
      await downloadImages(paths, filename);
      toast.success(`已下载 ${paths.length} 张图片`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    } finally {
      setIsDownloading(false);
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
  const apiUsage = data?.api_usage?.usage;
  const codexLogs = data?.codex_logs || [];
  const pricingModels = data?.api_pricing?.models || {};
  const apiBaseUrl =
    data?.api_base_url || (typeof window !== "undefined" ? `${window.location.origin}/v1` : "/v1");
  const curlExample = `curl ${apiBaseUrl}/chat/completions \\
  -H "Authorization: Bearer ${session.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"gpt-5.1","messages":[{"role":"user","content":"你好"}],"stream":false}'`;
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

      <section className="grid gap-3 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <BarChart3 className="size-4 text-muted-foreground" />
                API 使用数据
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Token 成本按 {data?.api_usage?.pricing_model || data?.api_pricing?.default_model || "gpt-5.1"} 官方 API 价格估算，实际以 OpenAI 账单为准。
              </div>
            </div>
            <div className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
              {formatUsd(data?.api_usage?.estimated_cost_usd)}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {[
              ["总请求", formatNumber(data?.api_usage?.total_calls)],
              ["输入 Token", formatNumber(apiUsage?.input_tokens)],
              ["输出 Token", formatNumber(apiUsage?.output_tokens)],
              ["Chat", formatNumber(apiUsage?.chat_calls)],
              ["Responses", formatNumber(apiUsage?.response_calls)],
              ["搜索", formatNumber(apiUsage?.search_calls)],
              ["图片/任务", formatNumber(apiUsage?.image_calls)],
              ["附件", formatNumber(apiUsage?.attachments)],
              ["生成图片", formatNumber(apiUsage?.images)],
              ["Models", formatNumber(apiUsage?.model_calls)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border bg-background px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="mt-1 truncate text-lg font-black text-foreground">{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
            <DollarSign className="size-4 text-muted-foreground" />
            Token 价格
          </div>
          <div className="space-y-2">
            {Object.entries(pricingModels).slice(0, 5).map(([model, price]) => (
              <div key={model} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background px-3 py-2 text-xs">
                <span className="font-medium text-foreground">{model}</span>
                <span className="text-right text-muted-foreground">
                  in ${price.input}/1M · out ${price.output}/1M
                </span>
              </div>
            ))}
          </div>
          <a
            href={data?.api_pricing?.source || "https://openai.com/api/pricing"}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex text-xs font-medium text-primary hover:underline"
          >
            查看 OpenAI 官方价格
          </a>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card shadow-sm">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          onClick={() => setCodexLogsOpen((value) => !value)}
        >
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <FileText className="size-4 text-muted-foreground" />
              最近20条调用记录 - Codex
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              已收录 {codexLogs.length} 条，默认收起，展开后查看 token、费用和执行状态。
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground">
              {codexLogs.length} 条
            </span>
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${codexLogsOpen ? "rotate-180" : ""}`} />
          </div>
        </button>
        {codexLogsOpen ? (
          <div className="border-t border-border px-4 pb-4 pt-3">
            {codexLogs.length > 0 ? (
              <div className="overflow-x-auto">
                <div className="min-w-[980px] overflow-hidden rounded-xl border border-border bg-background">
                  <div className="grid grid-cols-[150px_110px_150px_repeat(6,minmax(86px,1fr))_80px] border-b border-border bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
                    <div>时间</div>
                    <div>用户</div>
                    <div>模型</div>
                    <div className="text-right">输入</div>
                    <div className="text-right">输出</div>
                    <div className="text-right">缓存</div>
                    <div className="text-right">思考</div>
                    <div className="text-right">总计</div>
                    <div className="text-right">费用</div>
                    <div className="text-right">状态</div>
                  </div>
                  {codexLogs.map((item) => (
                    <div key={item.id} className="grid grid-cols-[150px_110px_150px_repeat(6,minmax(86px,1fr))_80px] items-center border-b border-border/70 px-3 py-2 text-xs last:border-b-0">
                      <div className="whitespace-nowrap font-medium text-foreground">{item.time}</div>
                      <div className="truncate text-muted-foreground">{detailText(item, "user_name")}</div>
                      <div className="truncate font-medium text-foreground">{detailText(item, "model")}</div>
                      <div className="text-right tabular-nums text-muted-foreground">{compactToken(detailNumber(item, "input_tokens"))}</div>
                      <div className="text-right tabular-nums text-muted-foreground">{compactToken(detailNumber(item, "output_tokens"))}</div>
                      <div className="text-right tabular-nums text-muted-foreground">{compactToken(detailNumber(item, "cached_input_tokens"))}</div>
                      <div className="text-right tabular-nums text-muted-foreground">{compactToken(detailNumber(item, "reasoning_tokens"))}</div>
                      <div className="text-right font-semibold tabular-nums text-foreground">{compactToken(detailNumber(item, "total_tokens"))}</div>
                      <div className="text-right font-semibold tabular-nums text-foreground">{compactUsd(detailNumber(item, "estimated_cost_usd"))}</div>
                      <div className="text-right">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${item.detail?.status === "failed" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-700"}`}>
                          {logStatus(item)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-background p-4 text-sm text-muted-foreground">
                暂无 Codex 调用记录。
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Code2 className="size-4 text-muted-foreground" />
              API 说明和使用方式
            </div>
            <div className="mt-1 text-xs text-muted-foreground">兼容 OpenAI SDK、Chat Completions、Responses、Images、Models。</div>
          </div>
          <Button type="button" variant="outline" className="rounded-xl" onClick={() => void copyText(apiBaseUrl, "Base URL 已复制")}>
            <Copy className="size-4" />
            复制 Base URL
          </Button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-2 rounded-xl border border-border bg-background p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">Base URL</span>
              <code className="truncate text-xs">{apiBaseUrl}</code>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">API Key</span>
              <span className="inline-flex items-center gap-2 text-xs">
                <KeyRound className="size-3.5" />
                {maskKey(session.key)}
              </span>
            </div>
            <div className="text-xs leading-6 text-muted-foreground">
              OpenAI SDK 的 baseURL 填上方地址，apiKey 填当前登录密钥；Codex/IDE 也使用同样 Base URL 和 Bearer Key。
            </div>
          </div>
          <div className="rounded-xl border border-border bg-background p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">curl 示例</span>
              <Button type="button" variant="ghost" className="h-7 rounded-lg px-2 text-xs" onClick={() => void copyText(curlExample, "示例已复制")}>
                <Copy className="size-3.5" />
                复制
              </Button>
            </div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs leading-5 text-muted-foreground">{curlExample}</pre>
          </div>
        </div>
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
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
          <div className="text-sm font-semibold">生图记录</div>
          <div className="mt-1 text-xs text-muted-foreground">共 {data?.image_count || 0} 张，最近最多显示 60 张。</div>
        </div>
          <Button
            type="button"
            variant="outline"
            className="rounded-xl"
            disabled={isDownloading || (data?.images || []).length === 0}
            onClick={() => void downloadPaths((data?.images || []).map((image) => image.rel))}
          >
            {isDownloading ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
            打包下载
          </Button>
        </div>
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {(data?.images || []).length === 0 ? (
            <div className="col-span-full grid min-h-48 place-items-center text-sm text-muted-foreground">暂无生图记录</div>
          ) : (
            imageEntries.map((entry) => {
              if (entry.type === "folder") {
                return (
                  <div key={entry.id} className="overflow-hidden rounded-xl border border-border bg-background">
                    <div className="grid aspect-square grid-cols-2 gap-1 bg-muted p-2">
                      {entry.items.slice(0, 4).map((image) => (
                        <button key={image.rel} type="button" onClick={() => openImages(entry.items, entry.items.findIndex((item) => item.rel === image.rel))} className="overflow-hidden rounded-lg bg-background">
                          <img src={image.thumbnail_url || image.url} alt={image.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                    <div className="space-y-1 p-2">
                      <div className="flex items-center gap-1 truncate text-xs font-semibold">
                        <Folder className="size-3.5 shrink-0" />
                        <span className="truncate">{entry.title}</span>
                      </div>
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-medium hover:bg-muted"
                        onClick={() => void downloadPaths(entry.items.map((image) => image.rel), `${entry.title || entry.id}.zip`)}
                        disabled={isDownloading}
                      >
                        <Download className="size-3" />
                        打包下载
                      </button>
                      <div className="text-[11px] text-muted-foreground">收纳盒 · {entry.count} 张</div>
                    </div>
                  </div>
                );
              }
              const image = entry.item;
              return (
                <button key={image.rel} type="button" onClick={() => openImages(data?.images || [], Math.max(0, allLightboxImages.findIndex((item) => item.id === image.rel)))} className="overflow-hidden rounded-xl border border-border bg-background text-left">
                  <div className="aspect-square bg-muted">
                    <img src={image.thumbnail_url || image.url} alt={image.name} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                  </div>
                  <div className="space-y-1 p-2">
                    <div className="truncate text-xs font-semibold">{image.name}</div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>{image.created_at}</span>
                      <Maximize2 className="size-3.5 text-muted-foreground" />
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </section>
      <ImageLightbox
        images={lightboxImages}
        currentIndex={lightboxIndex}
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        onIndexChange={setLightboxIndex}
      />
    </main>
  );
}
