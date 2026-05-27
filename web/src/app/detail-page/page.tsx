"use client";

import { useMemo, useRef, useState } from "react";
import {
  Download,
  ImagePlus,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createImageEditTask, fetchImageTasks, type ImageTask } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type UploadImage = {
  id: string;
  file: File;
  dataUrl: string;
};

type DetailPageStatus = "idle" | "queued" | "running" | "success" | "error" | "canceled";

type DetailPageItem = {
  id: string;
  title: string;
  subtitle: string;
  size: string;
  prompt: string;
  status: DetailPageStatus;
  taskId?: string;
  imageUrl?: string;
  b64Json?: string;
  error?: string;
};

const platforms = ["淘宝/天猫", "京东", "拼多多", "抖音小店", "小红书", "Amazon"];
const regions = ["中国大陆", "中国港澳台", "东南亚", "北美", "欧洲", "日本", "韩国"];
const languages = ["中文", "英文", "中英双语", "日文", "韩文", "泰文", "越南文"];
const styles = ["高级简洁", "爆款促销", "小红书种草", "科技质感", "母婴温暖", "轻奢礼盒", "极简白底"];

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

async function filesToUploadImages(files: File[]) {
  return Promise.all(
    files
      .filter((file) => file.type.startsWith("image/"))
      .map(async (file) => ({
        id: createId(),
        file,
        dataUrl: await readFileAsDataUrl(file),
      })),
  );
}

function pageImageSource(page: DetailPageItem) {
  if (page.b64Json) {
    return `data:image/png;base64,${page.b64Json}`;
  }
  return page.imageUrl || "";
}

function applyTaskToPage(page: DetailPageItem, task: ImageTask): DetailPageItem {
  const first = task.data?.[0];
  if (task.status === "success") {
    if (!first?.url && !first?.b64_json) {
      return { ...page, status: "error", taskId: task.id, error: "任务成功但未返回图片" };
    }
    return {
      ...page,
      status: "success",
      taskId: task.id,
      imageUrl: first.url,
      b64Json: first.b64_json,
      error: undefined,
    };
  }
  if (task.status === "error" || task.status === "canceled") {
    return {
      ...page,
      status: task.status,
      taskId: task.id,
      error: task.error || (task.status === "canceled" ? "任务已取消" : "生成失败"),
    };
  }
  return { ...page, status: task.status, taskId: task.id, error: undefined };
}

function buildDetailPages(form: {
  productName: string;
  category: string;
  sellingPoints: string;
  platform: string;
  region: string;
  language: string;
  style: string;
  audience: string;
  priceBand: string;
  extra: string;
  sameStyle: boolean;
}) {
  const product = form.productName.trim();
  const category = form.category.trim() || "电商商品";
  const sellingPoints = form.sellingPoints.trim() || "根据商品图提炼卖点、材质、功能、参数和购买理由";
  const audience = form.audience.trim() || "目标消费者";
  const priceBand = form.priceBand.trim() || "符合平台主流价格带";
  const extra = form.extra.trim();
  const sameStyle = form.sameStyle
    ? "参考图是目标版式和视觉风格，请尽量同款复刻它的排版节奏、分区方式、字体氛围、色彩层次和信息密度。"
    : "参考图只作为风格参考，不要照搬无关商品。";
  const base = [
    `为 ${form.platform} 生成电商详情页分页图。`,
    `商品名：${product}`,
    `类目：${category}`,
    `销售地区：${form.region}`,
    `语言：${form.language}`,
    `视觉风格：${form.style}`,
    `目标人群：${audience}`,
    `价格/定位：${priceBand}`,
    `商品卖点/参数：${sellingPoints}`,
    extra ? `补充要求：${extra}` : "",
    sameStyle,
    "必须严格参考上传的多角度商品图，保持商品外观、结构、颜色、材质、比例、Logo/纹理位置一致。",
    `如果出现文字，必须使用${form.language}，文字要短、清晰、可读；不要生成乱码、二维码、平台水印、虚假认证、夸大承诺。`,
    "高清商业视觉，适合移动端详情页，画面真实可信，产品主体清楚。",
  ]
    .filter(Boolean)
    .join("\n");

  const specs = [
    {
      title: "01 首屏主视觉",
      subtitle: "商品定位 + 核心利益点",
      prompt:
        "生成详情页第 1 页：首屏主视觉。第一眼讲清楚商品是什么、卖给谁、最大利益点是什么。商品占画面 60%-75%，背景高级干净，有强主视觉冲击力，预留标题和利益点区域。",
    },
    {
      title: "02 卖点总览",
      subtitle: "3-5 个核心卖点",
      prompt:
        "生成详情页第 2 页：卖点总览。围绕商品展示 3-5 个核心卖点，用分区、图标感符号、局部示意表达，信息层级清楚，像专业电商详情页第二屏。",
    },
    {
      title: "03 场景代入",
      subtitle: "真实使用场景",
      prompt:
        "生成详情页第 3 页：场景代入。把商品放入符合目标消费者审美的真实使用场景，透视自然，道具服务于卖点，产品仍然是视觉中心。",
    },
    {
      title: "04 材质细节",
      subtitle: "局部放大 + 工艺质感",
      prompt:
        "生成详情页第 4 页：材质和细节。展示材质、结构、接口、纹理、容量、按键、面料或关键细节，可使用主商品加 2-3 个局部放大窗口，不虚构不存在的功能。",
    },
    {
      title: "05 对比优势",
      subtitle: "差异化购买理由",
      prompt:
        "生成详情页第 5 页：对比优势。用左右对比或上下对比说明本商品相对普通产品的优势，对比克制可信，不做绝对化、医疗化、夸大承诺。",
    },
    {
      title: "06 参数包装",
      subtitle: "参数/包装/收尾转化",
      prompt:
        "生成详情页第 6 页：参数包装和收尾转化。展示规格参数、包装、配件、尺寸感、售后保障或购买理由，整体精致统一，适合作为详情页末屏。",
    },
  ];

  return specs.map((spec) => ({
    id: createId(),
    title: spec.title,
    subtitle: spec.subtitle,
    size: "3:4",
    prompt: `${base}\n\n${spec.prompt}\n只生成这一页，不要把 6 页都放进同一张图。`,
    status: "idle" as const,
  }));
}

async function pollTask(taskId: string) {
  let missingCount = 0;
  for (let index = 0; index < 120; index += 1) {
    const list = await fetchImageTasks([taskId]);
    const task = list.items[0];
    if (task) {
      if (task.status === "success" || task.status === "error" || task.status === "canceled") {
        return task;
      }
      missingCount = 0;
    } else if (list.missing_ids.includes(taskId)) {
      missingCount += 1;
      if (missingCount >= 3) {
        throw new Error("任务在服务器中未找到");
      }
    }
    await sleep(2000);
  }
  throw new Error("生成超时，请到日志管理查看该任务是否仍在运行");
}

function downloadPage(page: DetailPageItem) {
  const src = pageImageSource(page);
  if (!src) {
    toast.error("这页还没有可下载图片");
    return;
  }
  const link = document.createElement("a");
  link.href = src;
  link.download = `${page.title}.png`;
  link.click();
}

function UploadStrip({
  title,
  images,
  onPick,
  onRemove,
}: {
  title: string;
  images: UploadImage[];
  onPick: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-zinc-400">{title}</div>
      <div className="flex gap-2 overflow-x-auto">
        {images.map((image) => (
          <div key={image.id} className="relative size-16 shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900">
            <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onRemove(image.id)}
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-black/75 text-white"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onPick}
          className="inline-flex size-16 shrink-0 items-center justify-center rounded-2xl border border-dashed border-lime-300/70 bg-white/5 text-lime-300 transition hover:bg-lime-300/10"
        >
          <Plus className="size-6" />
        </button>
      </div>
    </div>
  );
}

export default function DetailPageGenerator() {
  const { isCheckingAuth, session } = useAuthGuard();
  const productInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [productImages, setProductImages] = useState<UploadImage[]>([]);
  const [referenceImages, setReferenceImages] = useState<UploadImage[]>([]);
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [platform, setPlatform] = useState(platforms[0]);
  const [region, setRegion] = useState(regions[0]);
  const [language, setLanguage] = useState(languages[0]);
  const [style, setStyle] = useState(styles[0]);
  const [audience, setAudience] = useState("");
  const [priceBand, setPriceBand] = useState("");
  const [extra, setExtra] = useState("");
  const [sameStyle, setSameStyle] = useState(true);
  const [pages, setPages] = useState<DetailPageItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const allFiles = useMemo(
    () => [...productImages.map((image) => image.file), ...referenceImages.map((image) => image.file)],
    [productImages, referenceImages],
  );
  const completeCount = pages.filter((page) => page.status === "success").length;
  const activeCount = pages.filter((page) => page.status === "queued" || page.status === "running").length;

  const addImages = async (kind: "product" | "reference", files: File[]) => {
    const images = await filesToUploadImages(files);
    if (images.length === 0) return;
    if (kind === "product") {
      setProductImages((prev) => [...prev, ...images].slice(0, 10));
    } else {
      setReferenceImages((prev) => [...prev, ...images].slice(0, 10));
    }
  };

  const removeImage = (kind: "product" | "reference", id: string) => {
    if (kind === "product") {
      setProductImages((prev) => prev.filter((item) => item.id !== id));
    } else {
      setReferenceImages((prev) => prev.filter((item) => item.id !== id));
    }
  };

  const updatePage = (id: string, updater: (page: DetailPageItem) => DetailPageItem) => {
    setPages((prev) => prev.map((page) => (page.id === id ? updater(page) : page)));
  };

  const runPageTask = async (page: DetailPageItem) => {
    updatePage(page.id, (current) => ({ ...current, status: "queued", error: undefined }));
    try {
      const taskId = `detail-${page.id}`;
      const submitted = await createImageEditTask(taskId, allFiles, page.prompt, "gpt-image-2", page.size);
      updatePage(page.id, (current) => applyTaskToPage(current, submitted));
      const finished = await pollTask(submitted.id);
      updatePage(page.id, (current) => applyTaskToPage(current, finished));
    } catch (error) {
      updatePage(page.id, (current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "生成失败",
      }));
    }
  };

  const handleGenerate = async () => {
    const normalizedProductName = productName.trim();
    if (!normalizedProductName) {
      toast.error("请先输入商品名");
      return;
    }
    if (productImages.length === 0) {
      toast.error("请至少上传一张商品图");
      return;
    }

    const nextPages = buildDetailPages({
      productName: normalizedProductName,
      category,
      sellingPoints,
      platform,
      region,
      language,
      style,
      audience,
      priceBand,
      extra,
      sameStyle,
    });
    setPages(nextPages);
    setIsGenerating(true);
    try {
      await Promise.all(nextPages.map((page) => runPageTask(page)));
      toast.success("6 张详情页分页图生成流程已结束");
    } finally {
      setIsGenerating(false);
    }
  };

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-zinc-400" />
      </div>
    );
  }

  return (
    <main className="min-h-[calc(100dvh-3.5rem)] bg-[#101010] text-white">
      <input
        ref={productInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void addImages("product", Array.from(event.target.files || []))}
      />
      <input
        ref={referenceInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void addImages("reference", Array.from(event.target.files || []))}
      />

      <section className="mx-auto grid w-full max-w-[1520px] gap-6 px-4 py-6 lg:grid-cols-[minmax(520px,0.92fr)_minmax(560px,1.08fr)] lg:px-8">
        <div className="space-y-4">
          <div className="rounded-[28px] border border-white/10 bg-[#191919] p-4">
            <UploadStrip
              title="参考图 / 同款风格图"
              images={referenceImages}
              onPick={() => referenceInputRef.current?.click()}
              onRemove={(id) => removeImage("reference", id)}
            />
          </div>

          <div className="rounded-[30px] border border-lime-300 bg-[#1b1b1b] p-4 shadow-[0_0_34px_rgba(190,255,0,0.14)]">
            <UploadStrip
              title="商品图，多角度上传"
              images={productImages}
              onPick={() => productInputRef.current?.click()}
              onRemove={(id) => removeImage("product", id)}
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <input
                value={productName}
                onChange={(event) => setProductName(event.target.value)}
                placeholder="商品名，例如：M330 II"
                className="h-11 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm outline-none placeholder:text-zinc-500 focus:border-lime-300"
              />
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="类目，例如：音箱"
                className="h-11 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm outline-none placeholder:text-zinc-500 focus:border-lime-300"
              />
            </div>

            <textarea
              value={sellingPoints}
              onChange={(event) => setSellingPoints(event.target.value)}
              placeholder="输入商品信息、卖点、参数，例如：多场景可移动音箱、2.1 声学、峰值功率 120W、Hi-Res 双金标..."
              rows={7}
              className="mt-3 min-h-40 w-full resize-none rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-sm leading-6 outline-none placeholder:text-zinc-500 focus:border-lime-300"
            />

            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              {[
                [platform, setPlatform, platforms],
                [region, setRegion, regions],
                [language, setLanguage, languages],
                [style, setStyle, styles],
              ].map(([value, setter, options], index) => (
                <select
                  key={index}
                  value={value as string}
                  onChange={(event) => (setter as (value: string) => void)(event.target.value)}
                  className="h-10 rounded-2xl border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-lime-300"
                >
                  {(options as string[]).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ))}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="目标人群，例如：宝妈、上班族、送礼人群"
                className="h-10 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm outline-none placeholder:text-zinc-500 focus:border-lime-300"
              />
              <input
                value={priceBand}
                onChange={(event) => setPriceBand(event.target.value)}
                placeholder="价格/定位，例如：中高端、性价比、礼盒款"
                className="h-10 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm outline-none placeholder:text-zinc-500 focus:border-lime-300"
              />
            </div>

            <input
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              placeholder="补充要求，例如：描述用英文、参考图同款版式、偏儿童换装卡片风..."
              className="mt-3 h-10 w-full rounded-2xl border border-white/10 bg-black/30 px-4 text-sm outline-none placeholder:text-zinc-500 focus:border-lime-300"
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white/5 px-3 py-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={sameStyle}
                  onChange={(event) => setSameStyle(event.target.checked)}
                  className="size-4 accent-lime-300"
                />
                一键同款参考图版式
              </label>
              <Button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating}
                className="rounded-full bg-lime-300 px-5 font-bold text-black hover:bg-lime-200"
              >
                {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                生成 6 张分页详情页
              </Button>
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="flex items-center justify-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl bg-violet-600 shadow-lg shadow-violet-600/30">
              <WandSparkles className="size-7" />
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-normal text-lime-300">AI 详情页</h1>
              <p className="mt-1 text-sm text-zinc-400">上传商品，一键生成 6 张分页详情页</p>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/10 bg-zinc-950/70">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <div>
                <div className="text-sm font-semibold">详情页分页结果</div>
                <div className="mt-1 text-xs text-zinc-500">
                  完成 {completeCount}/6
                  {activeCount > 0 ? `，生成中 ${activeCount}` : ""}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-white/5 text-white hover:bg-white/10"
                onClick={() => void handleGenerate()}
                disabled={isGenerating || productImages.length === 0 || !productName.trim()}
              >
                <RefreshCw className="size-4" />
                重新生成
              </Button>
            </div>

            <div className="grid gap-3 p-3 sm:grid-cols-2">
              {pages.length === 0 ? (
                <div className="col-span-full grid min-h-[520px] place-items-center text-center text-sm text-zinc-500">
                  上传商品图、参考图并输入商品信息后，点击生成 6 张分页详情页。
                </div>
              ) : (
                pages.map((page) => {
                  const src = pageImageSource(page);
                  return (
                    <div key={page.id} className="overflow-hidden rounded-2xl border border-white/10 bg-[#171717]">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{page.title}</div>
                          <div className="truncate text-xs text-zinc-500">{page.subtitle}</div>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-1 text-xs",
                            page.status === "success" && "bg-lime-300 text-black",
                            (page.status === "queued" || page.status === "running") && "bg-amber-400 text-black",
                            (page.status === "error" || page.status === "canceled") && "bg-rose-500 text-white",
                            page.status === "idle" && "bg-white/10 text-zinc-400",
                          )}
                        >
                          {page.status === "success"
                            ? "完成"
                            : page.status === "queued"
                              ? "排队"
                              : page.status === "running"
                                ? "生成中"
                                : page.status === "error"
                                  ? "失败"
                                  : page.status === "canceled"
                                    ? "取消"
                                    : "待生成"}
                        </span>
                      </div>
                      <div className="aspect-[3/4] bg-black/40">
                        {src ? (
                          <img src={src} alt={page.title} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full place-items-center px-5 text-center text-xs leading-5 text-zinc-500">
                            {page.status === "queued" || page.status === "running" ? (
                              <span className="inline-flex items-center gap-2">
                                <LoaderCircle className="size-4 animate-spin" />
                                {page.taskId ? `任务 ${page.taskId.slice(0, 12)}...` : "正在提交任务..."}
                              </span>
                            ) : (
                              page.error || "等待生成"
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="min-w-0 truncate text-[11px] text-zinc-500">
                          {page.taskId ? `任务ID：${page.taskId}` : "未提交"}
                        </span>
                        <button
                          type="button"
                          onClick={() => downloadPage(page)}
                          disabled={page.status !== "success"}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-black disabled:bg-white/10 disabled:text-zinc-600"
                        >
                          <Download className="size-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
