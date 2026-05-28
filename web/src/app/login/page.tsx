"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ImageIcon, Layers3, LoaderCircle, LockKeyhole, MessageCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createQQLoginUrl, fetchPublicCases, fetchPublicConfig, login } from "@/lib/api";
import { primeAuthSessionCache } from "@/lib/auth-session";
import { useRedirectIfAuthenticated } from "@/lib/use-auth-guard";
import { getDefaultRouteForRole, setStoredAuthSession } from "@/store/auth";

export default function LoginPage() {
  const router = useRouter();
  const [authKey, setAuthKey] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isQQSubmitting, setIsQQSubmitting] = useState(false);
  const [qqEnabled, setQQEnabled] = useState(true);
  const [freeQuota, setFreeQuota] = useState(0);
  const [inviteReward, setInviteReward] = useState(5);
  const [cases, setCases] = useState<Array<{ id: string; url: string; prompt?: string }>>([]);
  const [siteName, setSiteName] = useState("QQ1000 AI");
  const { isCheckingAuth } = useRedirectIfAuthenticated();

  const finishLogin = async (token: string) => {
    const data = await login(token);
    const nextSession = {
      key: token,
      role: data.role,
      subjectId: data.subject_id,
      name: data.name,
    };
    await setStoredAuthSession(nextSession);
    primeAuthSessionCache(nextSession);
    router.replace(getDefaultRouteForRole(data.role));
  };

  const handleLogin = async () => {
    const normalizedAuthKey = authKey.trim();
    if (!normalizedAuthKey) {
      toast.error("请输入 密钥");
      return;
    }

    setIsSubmitting(true);
    try {
      await finishLogin(normalizedAuthKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : "登录失败";
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleQQLogin = async () => {
    setIsQQSubmitting(true);
    try {
      const inviteCode = new URLSearchParams(window.location.search).get("invite") || "";
      const response = await createQQLoginUrl(inviteCode);
      window.location.href = response.authorize_url;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建 QQ 登录链接失败");
      setIsQQSubmitting(false);
    }
  };

  useEffect(() => {
    void fetchPublicConfig()
      .then((config) => {
        setSiteName(String(config.site_name || config.browser_title || "QQ1000 AI"));
        setQQEnabled(Boolean(config.qq_oauth_enabled));
        setFreeQuota(Math.max(0, Number(config.new_user_free_quota) || 0));
        setInviteReward(Math.max(0, Number(config.invite_reward_quota) || 0));
      })
      .catch(() => undefined);
    void fetchPublicCases()
      .then((data) => setCases((data.items || []).filter((item) => item.url).map((item) => ({ id: item.id, url: item.url, prompt: item.prompt })).slice(0, 6)))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("qq_login");
    if (!status) return;
    const token = params.get("token") || "";
    const message = params.get("message") || "";
    params.delete("qq_login");
    params.delete("token");
    params.delete("message");
    const nextSearch = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);

    if (status === "success" && token) {
      setIsQQSubmitting(true);
      void finishLogin(token).catch((error) => {
        toast.error(error instanceof Error ? error.message : "QQ 登录失败");
        setIsQQSubmitting(false);
      });
      return;
    }

    if (status === "unbound") {
      toast.error("QQ 登录暂不可用，请使用密钥登录");
      return;
    }
    toast.error(message || "QQ 登录失败");
  }, []);

  if (isCheckingAuth) {
    return (
      <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-1rem)] w-full place-items-center px-4 py-6">
      <div className="grid w-full max-w-6xl items-center gap-6 lg:grid-cols-[1.05fr_505px]">
        <section className="space-y-5 lg:hidden">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white/85 px-3 py-1.5 text-xs font-semibold text-stone-700 shadow-sm">
            <Sparkles className="size-3.5 text-[#12b7f5]" />
            {siteName}
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-black leading-tight tracking-tight text-stone-950">电商 AI 生图工作台</h1>
            <p className="text-sm leading-6 text-stone-600">QQ 登录后即可生成主图、买家秀和详情页素材。</p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {["主图", "买家秀", "详情页"].map((item) => (
              <div key={item} className="rounded-2xl border border-stone-200 bg-white/85 px-3 py-2 text-center text-xs font-bold text-stone-800 shadow-sm">
                {item}
              </div>
            ))}
          </div>
        </section>

        <section className="hidden space-y-6 lg:block">
          <div className="inline-flex items-center gap-2 rounded-full border border-stone-200 bg-white/80 px-4 py-2 text-sm font-medium text-stone-700 shadow-sm">
            <Sparkles className="size-4 text-[#12b7f5]" />
            {siteName} 电商 AI 生图工作台
          </div>
          <div className="space-y-4">
            <h1 className="max-w-2xl text-5xl font-black leading-tight tracking-tight text-stone-950">
              从产品图到主图、买家秀、详情页，一站式生成
            </h1>
            <p className="max-w-xl text-base leading-7 text-stone-600">
              面向淘宝、天猫、小红书、抖音和跨境平台，集中完成电商素材生成、复刻、尺寸适配和图片管理。
            </p>
          </div>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {[
              { icon: ImageIcon, title: "爆款主图", desc: "参考图复刻与白底图" },
              { icon: Layers3, title: "AI 详情页", desc: "分页图与长图拼接" },
              { icon: MessageCircle, title: "买家秀", desc: "真实场景生活感" },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <div key={item.title} className="rounded-2xl border border-stone-200 bg-white/85 p-4 shadow-sm">
                  <Icon className="mb-3 size-5 text-stone-950" />
                  <div className="text-sm font-bold text-stone-950">{item.title}</div>
                  <div className="mt-1 text-xs leading-5 text-stone-500">{item.desc}</div>
                </div>
              );
            })}
          </div>
          <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
            {["上传商品图", "选择场景模板", "一键生成成品"].map((step, index) => (
              <div key={step} className="rounded-2xl border border-stone-200 bg-white/75 p-4 shadow-sm">
                <div className="mb-3 inline-flex size-8 items-center justify-center rounded-full bg-stone-950 text-sm font-black text-white">{index + 1}</div>
                <div className="text-sm font-bold text-stone-950">{step}</div>
              </div>
            ))}
          </div>
          {cases.length > 0 ? (
            <div className="max-w-2xl space-y-3">
              <div className="text-sm font-bold text-stone-900">真实案例库</div>
              <div className="grid grid-cols-3 gap-3">
                {cases.map((item) => (
                  <div key={item.id} className="overflow-hidden rounded-2xl border border-white/80 bg-white shadow-sm">
                    <img src={item.url} alt={item.prompt || "真实案例"} className="aspect-square h-full w-full object-cover" />
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>

      <Card className="w-full rounded-[30px] border-white/80 bg-white/95 shadow-[0_28px_90px_rgba(28,25,23,0.10)]">
        <CardContent className="space-y-7 p-6 sm:p-8">
          <div className="space-y-4 text-center">
            <div className="mx-auto inline-flex size-14 items-center justify-center rounded-[18px] bg-stone-950 text-white shadow-sm">
              <LockKeyhole className="size-5" />
            </div>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">欢迎回来</h1>
              <p className="text-sm leading-6 text-stone-500">使用 QQ 登录或输入密钥，继续生成电商图片素材。</p>
            </div>
          </div>

          <div className="rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-center text-sm font-semibold text-sky-900">
            新用户 QQ 授权自动开通，免费额度 {freeQuota} 张
          </div>
          <div className="rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-center text-sm font-semibold text-emerald-900">
            邀请 1 位新用户，奖励 {inviteReward} 张生图额度
          </div>

          <Button
            className="h-13 w-full rounded-2xl bg-[#12b7f5] text-white shadow-sm hover:bg-[#0aa7e2]"
            style={{ minHeight: 52, backgroundColor: "#12b7f5", color: "#ffffff", WebkitTextFillColor: "#ffffff" }}
            onClick={() => void handleQQLogin()}
            disabled={isQQSubmitting || !qqEnabled}
          >
            {isQQSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : <MessageCircle className="size-4" />}
            QQ 登录
          </Button>

          <div className="flex items-center gap-3 text-xs text-stone-400">
            <span className="h-px flex-1 bg-stone-200" />
            <span>或使用密钥</span>
            <span className="h-px flex-1 bg-stone-200" />
          </div>

          <div className="space-y-3">
            <label htmlFor="auth-key" className="block text-sm font-medium text-stone-700">
              密钥
            </label>
            <Input
              id="auth-key"
              type="password"
              value={authKey}
              onChange={(event) => setAuthKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void handleLogin();
                }
              }}
              placeholder="请输入密钥"
              className="h-13 rounded-2xl border-stone-200 bg-white px-4"
            />
          </div>

          <Button
            className="h-13 w-full rounded-2xl bg-stone-950 text-white hover:bg-stone-800"
            style={{ minHeight: 52, backgroundColor: "#0c0a09", color: "#ffffff", WebkitTextFillColor: "#ffffff" }}
            onClick={() => void handleLogin()}
            disabled={isSubmitting}
          >
            {isSubmitting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            登录
          </Button>
          {!qqEnabled ? <p className="text-center text-xs text-stone-400">后台未配置 QQ 互联，暂时只能使用密钥登录。</p> : null}
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
