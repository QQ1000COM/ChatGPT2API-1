"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, EyeOff, LoaderCircle, Plus, Save, Trash2, WandSparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteTemplate, fetchFeedbackStats, fetchTemplates, saveTemplate, type CommerceTemplate } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const blankTemplate: Partial<CommerceTemplate> = {
  title: "",
  description: "",
  example_url: "",
  prompt: "",
  platform: "",
  tool_url: "/detail-page",
  hidden: false,
  sort: 0,
};

const fallbackTemplates: CommerceTemplate[] = [
  { id: "hot-main", title: "爆款主图复刻", description: "上传商品图和参考图，复刻构图、光影和促销氛围。", example_url: "", prompt: "复刻参考图风格，替换为我的产品。", platform: "淘宝/天猫", tool_url: "/detail-page", hidden: false, sort: 1 },
  { id: "buyer-show", title: "买家秀随手拍", description: "居家、街拍、开箱、评价晒单等生活化场景。", example_url: "", prompt: "真实买家随手拍，自然光，不要电商海报文字。", platform: "小红书/淘宝评价", tool_url: "/detail-page", hidden: false, sort: 2 },
  { id: "detail-pages", title: "AI 详情页分页", description: "一键生成移动端详情页分页图。", example_url: "", prompt: "生成电商详情页分页图。", platform: "淘宝/跨境", tool_url: "/detail-page", hidden: false, sort: 3 },
];

export default function TemplatesPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [items, setItems] = useState<CommerceTemplate[]>([]);
  const [form, setForm] = useState<Partial<CommerceTemplate>>(blankTemplate);
  const [stats, setStats] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const isAdmin = session?.role === "admin";

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchTemplates(Boolean(isAdmin));
      setItems((data.items || []).length > 0 ? data.items : fallbackTemplates);
      if (isAdmin) {
        const statData = await fetchFeedbackStats().catch(() => ({ items: [], total: 0 }));
        const next: Record<string, string> = {};
        for (const row of statData.items) {
          next[row.template_id] = `${row.avg_rating} 分 / 收藏 ${row.favorite_count}`;
        }
        setStats(next);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载模板失败");
      setItems(fallbackTemplates);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!session) return;
    void load();
  }, [session?.role]);

  const save = async () => {
    try {
      const data = await saveTemplate(form);
      setItems(data.items);
      setForm(blankTemplate);
      toast.success("模板已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存模板失败");
    }
  };

  const remove = async (id: string) => {
    try {
      const data = await deleteTemplate(id);
      setItems(data.items);
      toast.success("模板已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除模板失败");
    }
  };

  if (isCheckingAuth || !session) return <div className="min-h-[50vh]" />;

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">Template Market</div>
          <h1 className="mt-2 text-2xl font-black text-foreground">模板市场</h1>
          <p className="mt-1 text-sm text-muted-foreground">按电商场景沉淀模板，管理员可维护标题、示例图、提示词和跳转工具。</p>
        </div>
        {isAdmin ? (
          <Button type="button" variant="outline" className="rounded-full" onClick={() => setForm(blankTemplate)}>
            <Plus className="size-4" />
            新模板
          </Button>
        ) : null}
      </div>

      {isAdmin ? (
        <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm md:grid-cols-2">
          <Input placeholder="标题" value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Input placeholder="适用平台" value={form.platform || ""} onChange={(e) => setForm({ ...form, platform: e.target.value })} />
          <Input placeholder="示例图 URL" value={form.example_url || ""} onChange={(e) => setForm({ ...form, example_url: e.target.value })} />
          <Input placeholder="跳转工具，例如 /detail-page" value={form.tool_url || ""} onChange={(e) => setForm({ ...form, tool_url: e.target.value })} />
          <Input placeholder="排序" type="number" value={String(form.sort ?? 0)} onChange={(e) => setForm({ ...form, sort: Number(e.target.value) || 0 })} />
          <label className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={Boolean(form.hidden)} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} />
            隐藏模板
          </label>
          <Textarea className="md:col-span-2" placeholder="描述" value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <Textarea className="md:col-span-2" placeholder="默认提示词" value={form.prompt || ""} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <Button className="rounded-xl bg-foreground text-background md:col-span-2" onClick={() => void save()}>
            <Save className="size-4" />
            保存模板
          </Button>
        </section>
      ) : null}

      {loading ? (
        <div className="grid min-h-48 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.filter((item) => isAdmin || !item.hidden).map((item) => (
            <div key={item.id} className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              {item.example_url ? <img src={item.example_url} alt={item.title} className="aspect-[4/3] w-full object-cover" /> : null}
              <div className="space-y-3 p-5">
                <div className="flex items-start justify-between gap-3">
                  <span className="grid size-11 place-items-center rounded-2xl bg-foreground text-background">
                    <WandSparkles className="size-5" />
                  </span>
                  {item.hidden ? <EyeOff className="size-4 text-muted-foreground" /> : null}
                </div>
                <div>
                  <div className="text-base font-black text-foreground">{item.title}</div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {item.platform ? <span className="rounded-full bg-secondary px-2 py-1">{item.platform}</span> : null}
                  {isAdmin && stats[item.id] ? <span className="rounded-full bg-secondary px-2 py-1">{stats[item.id]}</span> : null}
                </div>
                <div className="flex gap-2">
                  <Link href={item.tool_url || "/detail-page"} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-xl bg-foreground px-3 text-sm font-bold text-background">
                    使用模板
                    <ArrowRight className="size-4" />
                  </Link>
                  {isAdmin ? (
                    <>
                      <Button type="button" variant="outline" className="rounded-xl" onClick={() => setForm(item)}>编辑</Button>
                      <Button type="button" variant="outline" className="rounded-xl text-rose-600" onClick={() => void remove(item.id)}><Trash2 className="size-4" /></Button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
