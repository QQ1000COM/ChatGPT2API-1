"use client";

import { useMemo, useRef, useState } from "react";
import {
  Download,
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

type WorkMode = "detail" | "main" | "white";
type UploadKind = "product" | "reference";
type JobStatus = "idle" | "queued" | "running" | "success" | "error" | "canceled";

type UploadImage = {
  id: string;
  file: File;
  dataUrl: string;
};

type PlatformSizePreset = {
  id: string;
  label: string;
  description: string;
  detail: string;
  main: string;
  white: string;
};

type GeneratedItem = {
  id: string;
  title: string;
  subtitle: string;
  size: string;
  prompt: string;
  status: JobStatus;
  taskId?: string;
  imageUrl?: string;
  b64Json?: string;
  error?: string;
};

const platforms = ["淘宝/天猫", "京东", "拼多多", "抖音小店", "小红书", "Amazon"];
const regions = ["中国大陆", "中国港澳台", "东南亚", "北美", "欧洲", "日本", "韩国"];
const languages = ["中文", "英文", "中英双语", "日文", "韩文", "泰文", "越南文"];
const styles = ["高级简洁", "爆款促销", "小红书种草", "科技质感", "母婴温暖", "轻奢礼盒", "极简白底"];
const platformSizePresets: PlatformSizePreset[] = [
  { id: "taobao", label: "淘宝/天猫", description: "详情页 3:4，主图/白底 1:1", detail: "3:4", main: "1:1", white: "1:1" },
  { id: "jd", label: "京东", description: "详情页 3:4，主图/白底 1:1", detail: "3:4", main: "1:1", white: "1:1" },
  { id: "pdd", label: "拼多多", description: "详情页 3:4，主图/白底 1:1", detail: "3:4", main: "1:1", white: "1:1" },
  { id: "douyin", label: "抖音小店", description: "详情页 9:16，主图/白底 1:1", detail: "9:16", main: "1:1", white: "1:1" },
  { id: "xiaohongshu", label: "小红书", description: "详情页/主图 3:4，白底 1:1", detail: "3:4", main: "3:4", white: "1:1" },
  { id: "amazon", label: "Amazon", description: "全模式 1:1", detail: "1:1", main: "1:1", white: "1:1" },
];

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

function imageSource(item: GeneratedItem) {
  if (item.b64Json) {
    return `data:image/png;base64,${item.b64Json}`;
  }
  return item.imageUrl || "";
}

function aspectClass(size: string) {
  switch (size) {
    case "16:9":
      return "aspect-video";
    case "9:16":
      return "aspect-[9/16]";
    case "4:3":
      return "aspect-[4/3]";
    case "3:4":
      return "aspect-[3/4]";
    default:
      return "aspect-square";
  }
}

function loadCanvasImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

async function sourceToDrawable(src: string) {
  if (src.startsWith("data:")) {
    return loadCanvasImage(src);
  }
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error("图片下载失败");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadCanvasImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function applyTaskToItem(item: GeneratedItem, task: ImageTask): GeneratedItem {
  const first = task.data?.[0];
  if (task.status === "success") {
    if (!first?.url && !first?.b64_json) {
      return { ...item, status: "error", taskId: task.id, error: "任务成功但未返回图片" };
    }
    return {
      ...item,
      status: "success",
      taskId: task.id,
      imageUrl: first.url,
      b64Json: first.b64_json,
      error: undefined,
    };
  }
  if (task.status === "error" || task.status === "canceled") {
    return {
      ...item,
      status: task.status,
      taskId: task.id,
      error: task.error || (task.status === "canceled" ? "任务已取消" : "生成失败"),
    };
  }
  return { ...item, status: task.status, taskId: task.id, error: undefined };
}

function basePrompt(form: {
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
    ? "参考图是目标版式和视觉风格，请尽量同款复刻它的构图节奏、主体比例、色彩层次、信息密度和商业氛围。"
    : "参考图只作为风格参考，不要照搬无关商品。";

  return [
    `商品名：${product}`,
    `类目：${category}`,
    `销售平台：${form.platform}`,
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
    "高清商业视觉，真实可信，产品主体清楚，可直接用于电商设计参考。",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildDetailItems(form: Parameters<typeof basePrompt>[0], size: string): GeneratedItem[] {
  const base = basePrompt(form);
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
    size,
    prompt: `${base}\n\n${spec.prompt}\n画面比例必须适配 ${size}。只生成这一页，不要把 6 页都放进同一张图。`,
    status: "idle",
  }));
}

function buildMainItems(form: Parameters<typeof basePrompt>[0], size: string): GeneratedItem[] {
  const base = basePrompt(form);
  const specs = [
    {
      title: "主图 A 同款复刻",
      subtitle: "最大程度复刻爆款版式",
      prompt:
        "生成 1:1 电商爆款主图。把参考图作为爆款主图模板，复刻它的主体位置、视角、背景层次、光影、道具关系、信息区布局和促销氛围，但替换成上传商品图中的商品。商品必须清晰完整，适合淘宝/天猫列表页点击。",
    },
    {
      title: "主图 B 强点击",
      subtitle: "更强视觉冲击",
      prompt:
        "生成 1:1 高点击电商主图。在同款参考图版式基础上增强产品质感、对比度、光影和空间层次，突出商品核心卖点，画面干净有记忆点，移动端缩略图也能看清。",
    },
    {
      title: "主图 C 场景种草",
      subtitle: "更适合内容平台",
      prompt:
        "生成 1:1 场景化爆款主图。参考图决定构图和视觉风格，加入符合目标人群的真实使用场景或氛围道具，商品仍然是主角，适合抖音、小红书和电商种草入口。",
    },
  ];

  return specs.map((spec) => ({
    id: createId(),
    title: spec.title,
    subtitle: spec.subtitle,
    size,
    prompt: `${base}\n\n${spec.prompt}\n画面比例必须适配 ${size}。只生成一张主图，不要生成详情页，不要拼多张图。`,
    status: "idle",
  }));
}

function buildWhiteItems(form: Parameters<typeof basePrompt>[0], size: string): GeneratedItem[] {
  const base = basePrompt({ ...form, sameStyle: false });
  const specs = [
    {
      title: "白底图 A 精修白底图",
      subtitle: "平台审核 / 搜索列表",
      prompt:
        "生成 1:1 精修白底商品图。纯白或接近纯白背景，商品居中完整展示，占画面 75%-88%，边缘干净，透视自然，材质、颜色、Logo 和纹理准确，柔和真实投影，不添加文字、边框、促销元素、装饰道具或平台水印，适合淘宝/天猫/京东白底图审核和搜索列表。",
    },
    {
      title: "白底图 B 3D白底图",
      subtitle: "立体质感 / 高级展示",
      prompt:
        "生成 1:1 3D质感白底商品图。白色或浅灰白摄影棚背景，保留真实商品外观和比例，强化立体光影、边缘高光、材质细节和高级商业摄影质感，商品可轻微悬浮或置于极简白色台面，投影自然，不添加文字、促销信息、无关道具、二维码或水印。",
    },
  ];

  return specs.map((spec) => ({
    id: createId(),
    title: spec.title,
    subtitle: spec.subtitle,
    size,
    prompt: `${base}\n\n${spec.prompt}\n画面比例必须适配 ${size}。只生成一张白底图，不要生成详情页，不要拼多张图。`,
    status: "idle",
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

function downloadItem(item: GeneratedItem) {
  const src = imageSource(item);
  if (!src) {
    toast.error("这张图还不能下载");
    return;
  }
  const link = document.createElement("a");
  link.href = src;
  link.download = `${item.title}.png`;
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
      <div className="text-xs font-semibold text-muted-foreground">{title}</div>
      <div className="flex gap-2 overflow-x-auto">
        {images.map((image) => (
          <div
            key={image.id}
            className="relative size-16 shrink-0 overflow-hidden rounded-2xl border border-border bg-muted"
          >
            <img src={image.dataUrl} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => onRemove(image.id)}
              className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded-full bg-foreground/80 text-background"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onPick}
          className="inline-flex size-16 shrink-0 items-center justify-center rounded-2xl border border-dashed border-border bg-muted text-foreground transition hover:bg-secondary"
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
  const [mode, setMode] = useState<WorkMode>("detail");
  const [productImages, setProductImages] = useState<UploadImage[]>([]);
  const [referenceImages, setReferenceImages] = useState<UploadImage[]>([]);
  const [productName, setProductName] = useState("");
  const [category, setCategory] = useState("");
  const [sellingPoints, setSellingPoints] = useState("");
  const [platform, setPlatform] = useState(platforms[0]);
  const [region, setRegion] = useState(regions[0]);
  const [language, setLanguage] = useState(languages[0]);
  const [style, setStyle] = useState(styles[0]);
  const [sizePresetId, setSizePresetId] = useState(platformSizePresets[0].id);
  const [audience, setAudience] = useState("");
  const [priceBand, setPriceBand] = useState("");
  const [extra, setExtra] = useState("");
  const [sameStyle, setSameStyle] = useState(true);
  const [items, setItems] = useState<GeneratedItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const allFiles = useMemo(
    () => [...productImages.map((image) => image.file), ...referenceImages.map((image) => image.file)],
    [productImages, referenceImages],
  );
  const completeCount = items.filter((item) => item.status === "success").length;
  const activeCount = items.filter((item) => item.status === "queued" || item.status === "running").length;
  const totalCount = mode === "detail" ? 6 : mode === "main" ? 3 : 2;
  const sizePreset = platformSizePresets.find((item) => item.id === sizePresetId) || platformSizePresets[0];
  const currentSize = mode === "detail" ? sizePreset.detail : mode === "main" ? sizePreset.main : sizePreset.white;
  const canStitchDetail =
    mode === "detail" && items.length === 6 && items.every((item) => item.status === "success" && imageSource(item));

  const addImages = async (kind: UploadKind, files: File[]) => {
    const images = await filesToUploadImages(files);
    if (images.length === 0) return;
    if (kind === "product") {
      setProductImages((prev) => [...prev, ...images].slice(0, 10));
    } else {
      setReferenceImages((prev) => [...prev, ...images].slice(0, 10));
    }
  };

  const removeImage = (kind: UploadKind, id: string) => {
    if (kind === "product") {
      setProductImages((prev) => prev.filter((item) => item.id !== id));
    } else {
      setReferenceImages((prev) => prev.filter((item) => item.id !== id));
    }
  };

  const updateItem = (id: string, updater: (item: GeneratedItem) => GeneratedItem) => {
    setItems((prev) => prev.map((item) => (item.id === id ? updater(item) : item)));
  };

  const runItemTask = async (item: GeneratedItem) => {
    updateItem(item.id, (current) => ({ ...current, status: "queued", error: undefined }));
    try {
      const taskPrefix = mode === "detail" ? "detail" : mode === "main" ? "main" : "white";
      const taskId = `${taskPrefix}-${item.id}`;
      const taskFiles = mode === "white" ? productImages.map((image) => image.file) : allFiles;
      const submitted = await createImageEditTask(taskId, taskFiles, item.prompt, "gpt-image-2", item.size);
      updateItem(item.id, (current) => applyTaskToItem(current, submitted));
      const finished = await pollTask(submitted.id);
      updateItem(item.id, (current) => applyTaskToItem(current, finished));
    } catch (error) {
      updateItem(item.id, (current) => ({
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
    if (mode === "main" && referenceImages.length === 0) {
      toast.error("请上传爆款主图参考图");
      return;
    }

    const form = {
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
    };
    const nextItems =
      mode === "detail"
        ? buildDetailItems(form, currentSize)
        : mode === "main"
          ? buildMainItems(form, currentSize)
          : buildWhiteItems(form, currentSize);
    setItems(nextItems);
    setIsGenerating(true);
    try {
      await Promise.all(nextItems.map((item) => runItemTask(item)));
      toast.success(
        mode === "detail"
          ? "6 张分页详情页生成流程已结束"
          : mode === "main"
            ? "爆款主图复刻生成流程已结束"
            : "白底图生成流程已结束",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleModeChange = (nextMode: WorkMode) => {
    setMode(nextMode);
    setItems([]);
  };

  const handleDownloadDetailLongImage = async () => {
    if (!canStitchDetail) {
      toast.error("请先生成完整的 6 张详情页");
      return;
    }
    try {
      const images = await Promise.all(items.map((item) => sourceToDrawable(imageSource(item))));
      const targetWidth = Math.max(...images.map((image) => image.naturalWidth || image.width));
      const heights = images.map((image) => {
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        return Math.round((height * targetWidth) / width);
      });
      const targetHeight = heights.reduce((sum, height) => sum + height, 0);
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("浏览器不支持图片合成");
      }
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, targetWidth, targetHeight);
      let offsetY = 0;
      images.forEach((image, index) => {
        context.drawImage(image, 0, offsetY, targetWidth, heights[index]);
        offsetY += heights[index];
      });
      const link = document.createElement("a");
      const safeName = productName.trim() || "detail-page";
      link.href = canvas.toDataURL("image/png");
      link.download = `${safeName}-详情页长图.png`;
      link.click();
      toast.success("详情页长图已合成下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "详情页长图合成失败");
    }
  };

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const pageTitle = mode === "detail" ? "AI 详情页" : mode === "main" ? "爆款主图" : "白底图";
  const pageSubTitle =
    mode === "detail"
      ? "上传商品，一键生成 6 张分页详情页"
      : mode === "main"
        ? "上传爆款参考图，一键复刻 3 张主图"
        : "上传商品图，一键生成精修白底图和 3D 白底图";
  const referenceTitle =
    mode === "detail" ? "参考图 / 同款风格图" : mode === "main" ? "爆款主图参考图" : "白底参考图（可选）";
  const resultTitle =
    mode === "detail" ? "详情页分页结果" : mode === "main" ? "爆款主图复刻结果" : "白底图生成结果";
  const emptyText =
    mode === "detail"
      ? "上传商品图、参考图并输入商品信息后，点击生成 6 张分页详情页。"
      : mode === "main"
        ? "上传商品图、爆款参考图并输入商品信息后，点击生成爆款主图。"
        : "上传商品图并输入商品信息后，点击生成精修白底图和 3D 白底图。";

  return (
    <main className="min-h-[calc(100dvh-3.5rem)] bg-background text-foreground [background-image:linear-gradient(to_right,rgba(15,23,42,0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.06)_1px,transparent_1px)] [background-size:32px_32px]">
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
          <div className="rounded-[28px] border border-border bg-card p-4 shadow-sm">
            <UploadStrip
              title={referenceTitle}
              images={referenceImages}
              onPick={() => referenceInputRef.current?.click()}
              onRemove={(id) => removeImage("reference", id)}
            />
          </div>

          <div className="rounded-[30px] border border-border bg-card p-4 shadow-sm">
            <div className="mb-4 inline-flex rounded-full bg-secondary p-1">
              {[
                ["detail", "详情页分页"],
                ["main", "爆款主图"],
                ["white", "白底图"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleModeChange(value as WorkMode)}
                  className={cn(
                    "h-9 rounded-full px-4 text-sm font-semibold transition",
                    mode === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

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
                className="h-11 rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
              <input
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                placeholder="类目，例如：音箱"
                className="h-11 rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
            </div>

            <textarea
              value={sellingPoints}
              onChange={(event) => setSellingPoints(event.target.value)}
              placeholder="输入商品信息、卖点、参数，例如：多场景可移动音箱、2.1 声学、峰值功率 120W、Hi-Res 双金标..."
              rows={7}
              className="mt-3 min-h-40 w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm leading-6 outline-none placeholder:text-muted-foreground focus:border-foreground"
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
                  className="h-10 rounded-2xl border border-input bg-background px-3 text-sm outline-none focus:border-foreground"
                >
                  {(options as string[]).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ))}
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,0.62fr)_minmax(0,1fr)]">
              <select
                value={sizePresetId}
                onChange={(event) => setSizePresetId(event.target.value)}
                className="h-10 rounded-2xl border border-input bg-background px-3 text-sm outline-none focus:border-foreground"
              >
                {platformSizePresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    一键换平台尺寸：{preset.label}
                  </option>
                ))}
              </select>
              <div className="flex min-h-10 items-center rounded-2xl border border-border bg-secondary px-3 text-xs text-muted-foreground">
                当前比例 {currentSize} · {sizePreset.description}
              </div>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="目标人群，例如：宝妈、上班族、送礼人群"
                className="h-10 rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
              <input
                value={priceBand}
                onChange={(event) => setPriceBand(event.target.value)}
                placeholder="价格/定位，例如：中高端、性价比、礼盒款"
                className="h-10 rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
            </div>

            <input
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              placeholder={
                mode === "detail"
                  ? "补充要求，例如：描述用英文、参考图同款版式、偏儿童换装卡片风..."
                  : mode === "main"
                    ? "补充要求，例如：复刻参考图构图、主图更高端、保留促销留白..."
                    : "补充要求，例如：阴影更轻、产品更居中、保留原始颜色、增加金属质感..."
              }
              className="mt-3 h-10 w-full rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {mode !== "white" ? (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={sameStyle}
                    onChange={(event) => setSameStyle(event.target.checked)}
                    className="size-4 accent-foreground"
                  />
                  一键同款参考图版式
                </label>
              ) : (
                <span />
              )}
              <Button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating}
                className="rounded-full bg-foreground px-5 font-bold text-background hover:bg-foreground/90"
              >
                {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {mode === "detail" ? "生成 6 张分页详情页" : mode === "main" ? "复刻 3 张爆款主图" : "生成 2 张白底图"}
              </Button>
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="flex items-center justify-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl bg-foreground text-background shadow-sm">
              <WandSparkles className="size-7" />
            </div>
            <div>
              <h1 className="text-4xl font-black tracking-normal text-foreground">{pageTitle}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{pageSubTitle}</p>
            </div>
          </div>

          <div className="rounded-[28px] border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{resultTitle}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  完成 {completeCount}/{totalCount}
                  {activeCount > 0 ? `，生成中 ${activeCount}` : ""}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {mode === "detail" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-border bg-background text-foreground hover:bg-secondary"
                    onClick={() => void handleDownloadDetailLongImage()}
                    disabled={!canStitchDetail}
                  >
                    <Download className="size-4" />
                    拼成长图
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-border bg-background text-foreground hover:bg-secondary"
                  onClick={() => void handleGenerate()}
                  disabled={isGenerating || productImages.length === 0 || !productName.trim()}
                >
                  <RefreshCw className="size-4" />
                  重新生成
                </Button>
              </div>
            </div>

            <div className="grid gap-3 p-3 sm:grid-cols-2">
              {items.length === 0 ? (
                <div className="col-span-full grid min-h-[520px] place-items-center text-center text-sm text-muted-foreground">
                  {emptyText}
                </div>
              ) : (
                items.map((item) => {
                  const src = imageSource(item);
                  return (
                    <div key={item.id} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{item.title}</div>
                          <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                        </div>
                        <span
                          className={cn(
                            "shrink-0 rounded-full px-2 py-1 text-xs",
                            item.status === "success" && "bg-emerald-100 text-emerald-700",
                            (item.status === "queued" || item.status === "running") && "bg-amber-400 text-black",
                            (item.status === "error" || item.status === "canceled") && "bg-rose-100 text-rose-700",
                            item.status === "idle" && "bg-secondary text-muted-foreground",
                          )}
                        >
                          {item.status === "success"
                            ? "完成"
                            : item.status === "queued"
                              ? "排队"
                              : item.status === "running"
                                ? "生成中"
                                : item.status === "error"
                                  ? "失败"
                                  : item.status === "canceled"
                                    ? "取消"
                                    : "待生成"}
                        </span>
                      </div>
                      <div className={cn("bg-muted", aspectClass(item.size))}>
                        {src ? (
                          <img src={src} alt={item.title} className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full place-items-center px-5 text-center text-xs leading-5 text-muted-foreground">
                            {item.status === "queued" || item.status === "running" ? (
                              <span className="inline-flex items-center gap-2">
                                <LoaderCircle className="size-4 animate-spin" />
                                {item.taskId ? `任务 ${item.taskId.slice(0, 12)}...` : "正在提交任务..."}
                              </span>
                            ) : (
                              item.error || "等待生成"
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                          {item.taskId ? `任务ID：${item.taskId}` : "未提交"}
                        </span>
                        <button
                          type="button"
                          onClick={() => downloadItem(item)}
                          disabled={item.status !== "success"}
                          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:bg-secondary disabled:text-muted-foreground"
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
