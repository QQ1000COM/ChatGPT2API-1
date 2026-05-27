"use client";

import { useEffect, useState } from "react";
import { EyeOff, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteHomeCase, fetchHomeCases, saveHomeCase, type HomeCase } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";

const blankCase: Partial<HomeCase> = {
  title: "",
  image_url: "",
  image_rel: "",
  category: "主图",
  hidden: false,
  sort: 0,
};

export default function CaseManagerPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);
  const [items, setItems] = useState<HomeCase[]>([]);
  const [form, setForm] = useState<Partial<HomeCase>>(blankCase);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await fetchHomeCases(true);
      setItems(data.items || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载案例失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!session) return;
    void load();
  }, [session]);

  const save = async () => {
    try {
      const data = await saveHomeCase(form);
      setItems(data.items);
      setForm(blankCase);
      toast.success("首页案例已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存案例失败");
    }
  };

  const remove = async (id: string) => {
    try {
      const data = await deleteHomeCase(id);
      setItems(data.items);
      toast.success("案例已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除案例失败");
    }
  };

  if (isCheckingAuth || !session) {
    return <div className="grid min-h-[50vh] place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <main className="mx-auto w-full max-w-6xl space-y-5 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.24em] text-muted-foreground">Case Manager</div>
          <h1 className="mt-2 text-2xl font-black text-foreground">首页案例库</h1>
          <p className="mt-1 text-sm text-muted-foreground">选择哪些真实案例上首页，支持排序、分类和隐藏。</p>
        </div>
        <Button type="button" variant="outline" className="rounded-full" onClick={() => setForm(blankCase)}>
          <Plus className="size-4" />
          新案例
        </Button>
      </div>

      <section className="grid gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm md:grid-cols-2">
        <Input placeholder="标题" value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <Input placeholder="分类，例如 主图 / 买家秀 / 详情页" value={form.category || ""} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <Input placeholder="图片 URL" value={form.image_url || ""} onChange={(e) => setForm({ ...form, image_url: e.target.value })} />
        <Input placeholder="图片 rel，可选" value={form.image_rel || ""} onChange={(e) => setForm({ ...form, image_rel: e.target.value })} />
        <Input placeholder="排序" type="number" value={String(form.sort ?? 0)} onChange={(e) => setForm({ ...form, sort: Number(e.target.value) || 0 })} />
        <label className="flex h-10 items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={Boolean(form.hidden)} onChange={(e) => setForm({ ...form, hidden: e.target.checked })} />
          隐藏案例
        </label>
        <Button className="rounded-xl bg-foreground text-background md:col-span-2" onClick={() => void save()}>
          <Save className="size-4" />
          保存案例
        </Button>
      </section>

      {loading ? (
        <div className="grid min-h-48 place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <div key={item.id} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
              {item.image_url ? <img src={item.image_url} alt={item.title} className="aspect-[4/3] w-full object-cover" /> : <div className="grid aspect-[4/3] place-items-center bg-muted text-sm text-muted-foreground">无图片</div>}
              <div className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold">{item.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.category} · 排序 {item.sort}</div>
                  </div>
                  {item.hidden ? <EyeOff className="size-4 text-muted-foreground" /> : null}
                </div>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" className="flex-1 rounded-xl" onClick={() => setForm(item)}>编辑</Button>
                  <Button type="button" variant="outline" className="rounded-xl text-rose-600" onClick={() => void remove(item.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
