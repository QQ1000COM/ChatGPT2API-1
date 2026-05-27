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

type WorkMode = "detail" | "main" | "buyer" | "white" | "resize";
type UploadKind = "product" | "reference" | "background" | "resize";
type JobStatus = "idle" | "queued" | "running" | "success" | "error" | "canceled";

type UploadImage = {
  id: string;
  file: File;
  dataUrl: string;
};

type ResizePreset = {
  id: string;
  ratio: string;
  label: string;
  orientation: string;
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
  localImageUrl?: string;
  b64Json?: string;
  error?: string;
  sourceFile?: File;
  sourceName?: string;
};

const platforms = ["淘宝/天猫", "京东", "拼多多", "抖音小店", "小红书", "Amazon"];
const regions = ["中国大陆", "中国港澳台", "东南亚", "北美", "欧洲", "日本", "韩国"];
const languages = ["中文", "英文", "中英双语", "日文", "韩文", "泰文", "越南文"];
const styles = ["高级简洁", "爆款促销", "小红书种草", "科技质感", "母婴温暖", "轻奢礼盒", "极简白底"];
const resizePresets: ResizePreset[] = [
  { id: "1:1", ratio: "1:1", label: "正方形", orientation: "" },
  { id: "16:9", ratio: "16:9", label: "横版", orientation: "横版" },
  { id: "4:3", ratio: "4:3", label: "横版", orientation: "横版" },
  { id: "3:4", ratio: "3:4", label: "竖版", orientation: "竖版" },
  { id: "9:16", ratio: "9:16", label: "竖版", orientation: "竖版" },
];

const buyerStyles = ["居家实拍", "街拍穿搭", "桌面开箱", "用户评价晒单", "种草笔记风", "真实买家随手拍"];
const buyerCounts = [1, 2, 4, 6];
const buyerRatios = ["1:1", "3:4", "4:5", "9:16"];
const buyerHumanModes = ["不出现真人，只拍产品生活场景", "出现手部/半身", "出现模特穿搭/使用"];
const buyerRealityLevels = ["精致", "自然", "随手拍", "很真实、有轻微瑕疵"];
const buyerPlatforms = ["淘宝评价图", "小红书种草图", "抖音橱窗图", "亚马逊 Lifestyle", "Shopee/Lazada 买家秀"];
const buyerBackgroundModes = [
  {
    id: "strict",
    label: "严格一致",
    prompt: "背景一致程度：严格一致。所有图片尽量保持同一张背景图的空间结构、光线、主要物体和拍摄位置，只允许轻微裁切和景深变化。",
  },
  {
    id: "natural",
    label: "自然变化",
    prompt:
      "背景一致程度：自然变化。把上传背景图理解为同一个空间，而不是同一张照片模板；所有图片仍在同一房间/同一车内/同一桌面环境中，但必须使用不同机位、不同裁切、不同焦段、不同商品摆放位置和不同手部/人物动作，避免看起来像复制同一张图。",
  },
  {
    id: "extended",
    label: "轻微延展",
    prompt:
      "背景一致程度：轻微延展。保留上传背景图的空间风格、材质、色温、主要家具/车内/桌面元素和生活氛围，允许合理延展同一空间的相邻角落、不同视角和自然遮挡，但不要跳到完全不同的场所。",
  },
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
  if (item.localImageUrl) {
    return item.localImageUrl;
  }
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
    case "4:5":
      return "aspect-[4/5]";
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
      localImageUrl: first.local_url,
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

function buildBuyerItems(
  form: Parameters<typeof basePrompt>[0] & { usageScene: string },
  options: {
    style: string;
    count: number;
    ratio: string;
    humanMode: string;
    reality: string;
    platform: string;
    consistentScene: boolean;
    hasBackgroundImage: boolean;
    backgroundMode: string;
  },
): GeneratedItem[] {
  const product = form.productName.trim();
  const category = form.category.trim() || "电商商品";
  const sellingPoints = form.sellingPoints.trim() || "根据商品图片提炼真实卖点、材质、用途和使用体验";
  const audience = form.audience.trim() || "目标买家";
  const usageScene = form.usageScene.trim() || "日常真实使用场景";
  const extra = form.extra.trim();
  const sameStyle = form.sameStyle
    ? "如果上传了买家秀参考图，请复刻参考图的构图、光线、拍摄距离、场景氛围、生活杂物密度和随手拍感觉，但必须替换成我上传的商品。"
    : "参考图只作为风格灵感，不要照抄无关商品、人物身份或品牌元素。";
  const consistentScene = options.consistentScene
    ? `本批 ${options.count} 张买家秀必须保持同一个大场景和同一套环境氛围：${usageScene}。例如选择家里就每张都在家里不同角落，选择车里就每张都在车内不同角度；允许构图、距离、手部动作和细节不同，但不要跳到户外、街边、浴室、办公室等其他场景。`
    : "本批图片可以根据每张主题切换自然场景，但都要符合商品和目标买家的真实使用逻辑。";
  const backgroundImage = options.hasBackgroundImage
    ? `已上传统一背景图：所有生成结果必须使用这张背景图作为同一处真实环境的视觉依据，商品、手部、半身或模特需要自然融入这张背景。${options.backgroundMode}`
    : "";
  const base = [
    `为 ${options.platform} 生成真实买家秀图片。`,
    `商品名：${product}`,
    `类目：${category}`,
    `商品卖点：${sellingPoints}`,
    `目标人群：${audience}`,
    `使用场景：${usageScene}`,
    `买家秀风格：${options.style}`,
    `真人模式：${options.humanMode}`,
    `真实度：${options.reality}`,
    extra ? `补充要求：${extra}` : "",
    sameStyle,
    consistentScene,
    backgroundImage,
    "必须严格参考上传的多角度商品图，保持商品外观、结构、颜色、材质、比例、Logo/纹理位置一致。",
    "手机拍摄感，自然光，轻微生活杂乱，不要太完美，不要夸张摆拍，商品必须真实出现并清楚可见。",
    "可以使用手持、桌面、衣架、床边、客厅、厨房、通勤、户外等自然场景，画面像真实买家随手拍。",
    "不要生成电商海报文字、促销字、二维码、水印、虚假品牌 Logo、虚假认证、夸大承诺或平台官方标识。",
    "如果必须出现少量文字，只能是自然评价晒单氛围里的短中文，不要占画面主体。",
  ]
    .filter(Boolean)
    .join("\n");
  const scenes = [
    {
      title: "买家秀 01 开箱图",
      subtitle: "包装/桌面/刚收到",
      prompt: "生成开箱买家秀：商品刚拆开或放在桌面/床边，包装、配件、日常杂物自然入镜，光线真实，像买家收到货后随手拍。",
    },
    {
      title: "买家秀 02 上身/使用图",
      subtitle: "真实使用状态",
      prompt: "生成上身或使用买家秀：按照真人模式展示商品被真实使用，动作自然，不摆拍，重点看清商品外观和使用方式。",
    },
    {
      title: "买家秀 03 细节图",
      subtitle: "材质/纹理/局部",
      prompt: "生成细节买家秀：近距离拍摄商品材质、纹理、接口、边缘、做工或关键结构，背景保持生活化，不做棚拍广告感。",
    },
    {
      title: "买家秀 04 场景图",
      subtitle: "生活方式氛围",
      prompt: "生成场景买家秀：把商品放入目标买家的真实生活场景中，环境自然有一点生活痕迹，商品仍是画面关注点。",
    },
    {
      title: "买家秀 05 评价晒单图",
      subtitle: "评价/晒单感",
      prompt: "生成评价晒单买家秀：像淘宝评价或小红书真实分享图片，构图随手但清楚，允许轻微不完美，不要做成广告海报。",
    },
    {
      title: "买家秀 06 对比图",
      subtitle: "使用前后/尺寸感",
      prompt: "生成对比买家秀：通过生活物件、手部、桌面或使用前后关系体现尺寸感、效果差异或购买理由，真实克制，不夸张宣传。",
    },
  ];

  return scenes.slice(0, options.count).map((scene) => ({
    id: createId(),
    title: scene.title,
    subtitle: `${options.platform} / ${options.style}`,
    size: options.ratio,
    prompt: `${base}\n\n${scene.prompt}\n画面比例必须适配 ${options.ratio}。只生成这一张买家秀图，不要拼图，不要生成多张图。`,
    status: "idle",
  }));
}

function buildResizeItems(images: UploadImage[], selectedRatios: string[]): GeneratedItem[] {
  const presets = resizePresets.filter((preset) => selectedRatios.includes(preset.id));
  return images.flatMap((image, imageIndex) =>
    presets.map((preset) => ({
      id: createId(),
      title: `${preset.ratio} ${preset.label || "比例图"}`,
      subtitle: image.file.name || `图片 ${imageIndex + 1}`,
      size: preset.ratio,
      prompt: [
        `将上传图片 AI 生成扩展为 ${preset.ratio} ${preset.orientation || "正方形"} 比例。`,
        "保持原图主体、商品外观、颜色、材质、Logo、文字和关键细节准确一致。",
        "根据目标比例智能补全背景、延展画面、优化构图和留白，不要简单拉伸变形，不要裁掉关键主体。",
        "画面真实自然，清晰干净，适合电商主图、广告图或内容平台素材使用。",
      ].join("\n"),
      status: "idle" as JobStatus,
      sourceFile: image.file,
      sourceName: image.file.name,
    })),
  );
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
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const resizeInputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<WorkMode>("detail");
  const [productImages, setProductImages] = useState<UploadImage[]>([]);
  const [referenceImages, setReferenceImages] = useState<UploadImage[]>([]);
  const [backgroundImages, setBackgroundImages] = useState<UploadImage[]>([]);
  const [resizeImages, setResizeImages] = useState<UploadImage[]>([]);
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
  const [usageScene, setUsageScene] = useState("");
  const [sameStyle, setSameStyle] = useState(true);
  const [buyerStyle, setBuyerStyle] = useState(buyerStyles[0]);
  const [buyerCount, setBuyerCount] = useState(4);
  const [buyerRatio, setBuyerRatio] = useState("4:5");
  const [buyerHumanMode, setBuyerHumanMode] = useState(buyerHumanModes[0]);
  const [buyerReality, setBuyerReality] = useState(2);
  const [buyerPlatform, setBuyerPlatform] = useState(buyerPlatforms[0]);
  const [buyerConsistentScene, setBuyerConsistentScene] = useState(true);
  const [buyerBackgroundMode, setBuyerBackgroundMode] = useState("natural");
  const [items, setItems] = useState<GeneratedItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [regeneratingItemIds, setRegeneratingItemIds] = useState<string[]>([]);
  const [selectedResizeRatios, setSelectedResizeRatios] = useState<string[]>([]);

  const allFiles = useMemo(
    () => [...productImages.map((image) => image.file), ...referenceImages.map((image) => image.file)],
    [productImages, referenceImages],
  );
  const buyerFiles = useMemo(
    () => [
      ...productImages.map((image) => image.file),
      ...referenceImages.map((image) => image.file),
      ...backgroundImages.map((image) => image.file),
    ],
    [backgroundImages, productImages, referenceImages],
  );
  const completeCount = items.filter((item) => item.status === "success").length;
  const activeCount = items.filter((item) => item.status === "queued" || item.status === "running").length;
  const totalCount =
    mode === "detail"
      ? 6
      : mode === "main"
        ? 3
        : mode === "buyer"
          ? buyerCount
          : mode === "white"
            ? 2
            : resizeImages.length * selectedResizeRatios.length;
  const canStitchDetail =
    mode === "detail" && items.length === 6 && items.every((item) => item.status === "success" && imageSource(item));

  const addImages = async (kind: UploadKind, files: File[]) => {
    const images = await filesToUploadImages(files);
    if (images.length === 0) return;
    if (kind === "product") {
      setProductImages((prev) => [...prev, ...images].slice(0, 10));
    } else if (kind === "reference") {
      setReferenceImages((prev) => [...prev, ...images].slice(0, 10));
    } else if (kind === "background") {
      setBackgroundImages(images.slice(0, 1));
    } else {
      setResizeImages((prev) => [...prev, ...images].slice(0, 20));
    }
  };

  const removeImage = (kind: UploadKind, id: string) => {
    if (kind === "product") {
      setProductImages((prev) => prev.filter((item) => item.id !== id));
    } else if (kind === "reference") {
      setReferenceImages((prev) => prev.filter((item) => item.id !== id));
    } else if (kind === "background") {
      setBackgroundImages((prev) => prev.filter((item) => item.id !== id));
    } else {
      setResizeImages((prev) => prev.filter((item) => item.id !== id));
    }
  };

  const updateItem = (id: string, updater: (item: GeneratedItem) => GeneratedItem) => {
    setItems((prev) => prev.map((item) => (item.id === id ? updater(item) : item)));
  };

  const runItemTask = async (item: GeneratedItem) => {
    let succeeded = false;
    updateItem(item.id, (current) => ({
      ...current,
      status: "queued",
      error: undefined,
      imageUrl: undefined,
      localImageUrl: undefined,
      b64Json: undefined,
    }));
    try {
      const taskPrefix =
        mode === "detail" ? "detail" : mode === "main" ? "main" : mode === "buyer" ? "buyer" : mode === "white" ? "white" : "resize";
      const taskId = `${taskPrefix}-${createId()}`;
      const taskFiles =
        mode === "resize"
          ? item.sourceFile
            ? [item.sourceFile]
            : []
          : mode === "white"
            ? productImages.map((image) => image.file)
            : mode === "buyer"
              ? buyerFiles
              : allFiles;
      const submitted = await createImageEditTask(taskId, taskFiles, item.prompt, "gpt-image-2", item.size);
      updateItem(item.id, (current) => applyTaskToItem(current, submitted));
      const finished = await pollTask(submitted.id);
      succeeded = finished.status === "success";
      updateItem(item.id, (current) => applyTaskToItem(current, finished));
    } catch (error) {
      updateItem(item.id, (current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : "生成失败",
      }));
    }
    return succeeded;
  };

  const handleGenerate = async () => {
    if (mode === "resize") {
      if (resizeImages.length === 0) {
        toast.error("请先上传需要 AI 改比例的图片");
        return;
      }
      if (selectedResizeRatios.length === 0) {
        toast.error("请选择至少一个比例");
        return;
      }
      const nextItems = buildResizeItems(resizeImages, selectedResizeRatios);
      setItems(nextItems);
      setIsGenerating(true);
      try {
        await Promise.all(nextItems.map((item) => runItemTask(item)));
        toast.success("AI 尺寸生成流程已结束");
      } finally {
        setIsGenerating(false);
      }
      return;
    }

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
      usageScene,
      sameStyle,
    };
    const nextItems =
      mode === "detail"
        ? buildDetailItems(form, "3:4")
        : mode === "main"
          ? buildMainItems(form, "1:1")
          : mode === "buyer"
            ? buildBuyerItems(form, {
                style: buyerStyle,
                count: buyerCount,
                ratio: buyerRatio,
                humanMode: buyerHumanMode,
                reality: buyerRealityLevels[buyerReality] || buyerRealityLevels[2],
                platform: buyerPlatform,
                consistentScene: buyerConsistentScene,
                hasBackgroundImage: backgroundImages.length > 0,
                backgroundMode: buyerBackgroundModes.find((item) => item.id === buyerBackgroundMode)?.prompt || buyerBackgroundModes[1].prompt,
              })
            : buildWhiteItems(form, "1:1");
    setItems(nextItems);
    setIsGenerating(true);
    try {
      await Promise.all(nextItems.map((item) => runItemTask(item)));
      toast.success(
        mode === "detail"
          ? "6 张分页详情页生成流程已结束"
          : mode === "main"
            ? "爆款主图复刻生成流程已结束"
            : mode === "buyer"
              ? "买家秀生成流程已结束"
              : "白底图生成流程已结束",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleModeChange = (nextMode: WorkMode) => {
    setMode(nextMode);
    setItems([]);
    setRegeneratingItemIds([]);
  };

  const toggleResizeRatio = (id: string) => {
    setSelectedResizeRatios((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
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

  const handleRegenerateItem = async (item: GeneratedItem) => {
    if (item.status === "queued" || item.status === "running" || regeneratingItemIds.includes(item.id)) {
      return;
    }
    if (mode === "resize") {
      if (!item.sourceFile) {
        toast.error("这张图的原图不存在，请重新上传");
        return;
      }
    } else if (productImages.length === 0) {
      toast.error("请先保留至少一张商品图");
      return;
    }

    setRegeneratingItemIds((prev) => [...prev, item.id]);
    try {
      const ok = await runItemTask(item);
      if (ok) {
        toast.success(`${item.title} 已重新生成`);
      } else {
        toast.error(`${item.title} 重新生成失败`);
      }
    } finally {
      setRegeneratingItemIds((prev) => prev.filter((id) => id !== item.id));
    }
  };

  if (isCheckingAuth || !session) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const pageTitle =
    mode === "detail"
      ? "AI 详情页"
      : mode === "main"
        ? "爆款主图"
        : mode === "buyer"
          ? "一键拍买家秀"
          : mode === "white"
            ? "白底图"
            : "尺寸转换";
  const pageSubTitle =
    mode === "detail"
      ? "上传商品，一键生成 6 张分页详情页"
      : mode === "main"
        ? "上传爆款参考图，一键复刻 3 张主图"
        : mode === "buyer"
          ? "上传商品图和买家秀参考图，一键生成真实晒单图片"
          : mode === "white"
          ? "上传商品图，一键生成精修白底图和 3D 白底图"
          : "上传图片，选择平台规格，一键导出多尺寸素材";
  const referenceTitle =
    mode === "detail"
      ? "参考图 / 同款风格图"
      : mode === "main"
        ? "爆款主图参考图"
        : mode === "buyer"
          ? "买家秀参考图（可选）"
          : mode === "white"
          ? "白底参考图（可选）"
          : "尺寸转换";
  const resultTitle =
    mode === "detail"
      ? "详情页分页结果"
      : mode === "main"
        ? "爆款主图复刻结果"
        : mode === "buyer"
          ? "买家秀生成结果"
          : mode === "white"
          ? "白底图生成结果"
          : "AI 尺寸生成结果";
  const emptyText =
    mode === "detail"
      ? "上传商品图、参考图并输入商品信息后，点击生成 6 张分页详情页。"
      : mode === "main"
        ? "上传商品图、爆款参考图并输入商品信息后，点击生成爆款主图。"
        : mode === "buyer"
          ? "上传多角度商品图，选择风格、真人模式、平台模板和数量后，一键生成真实买家秀。"
          : mode === "white"
          ? "上传商品图并输入商品信息后，点击生成精修白底图和 3D 白底图。"
          : "上传图片并选择比例后，点击 AI 生成尺寸图。";

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
      <input
        ref={backgroundInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void addImages("background", Array.from(event.target.files || []))}
      />
      <input
        ref={resizeInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => void addImages("resize", Array.from(event.target.files || []))}
      />

      <section className="mx-auto grid w-full max-w-[1520px] gap-6 px-4 py-6 lg:grid-cols-[minmax(520px,0.92fr)_minmax(560px,1.08fr)] lg:px-8">
        <div className="space-y-4">
          {mode === "resize" ? null : (
            <div className="rounded-[28px] border border-border bg-card p-4 shadow-sm">
              <UploadStrip
                title={referenceTitle}
                images={referenceImages}
                onPick={() => referenceInputRef.current?.click()}
                onRemove={(id) => removeImage("reference", id)}
              />
              {mode === "buyer" ? (
                <div className="mt-4">
                  <UploadStrip
                    title="统一背景图（可选，上传后整批买家秀使用同一背景）"
                    images={backgroundImages}
                    onPick={() => backgroundInputRef.current?.click()}
                    onRemove={(id) => removeImage("background", id)}
                  />
                </div>
              ) : null}
            </div>
          )}

          <div className="rounded-[30px] border border-border bg-card p-4 shadow-sm">
            <div className="mb-4 inline-flex rounded-full bg-secondary p-1">
              {[
                ["detail", "详情页分页"],
                ["main", "爆款主图"],
                ["buyer", "买家秀"],
                ["white", "白底图"],
                ["resize", "尺寸转换"],
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

            {mode === "resize" ? (
              <div className="space-y-4">
                <UploadStrip
                  title="上传图片，支持多张批量改尺寸"
                  images={resizeImages}
                  onPick={() => resizeInputRef.current?.click()}
                  onRemove={(id) => removeImage("resize", id)}
                />

                <div className="rounded-2xl border border-border bg-background p-3">
                  <div className="mb-3 text-sm font-semibold">选择比例</div>
                  <div className="space-y-2">
                    {resizePresets.map((preset) => {
                      const checked = selectedResizeRatios.includes(preset.id);
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => toggleResizeRatio(preset.id)}
                          className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-secondary"
                        >
                          <span
                            className={cn(
                              "grid size-7 place-items-center rounded-md border bg-secondary",
                              checked ? "border-foreground bg-foreground" : "border-muted-foreground/40 bg-background",
                            )}
                          >
                            {checked ? <span className="size-3 rounded-sm bg-background" /> : null}
                          </span>
                          <span className="min-w-0 flex items-baseline gap-2">
                            <span className="font-semibold">{preset.ratio}</span>
                            <span className="text-xs text-muted-foreground">{preset.label}</span>
                          </span>
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{preset.orientation}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">AI 会智能扩图补背景，不会简单拉伸变形。</div>
                  <Button
                    type="button"
                    onClick={() => void handleGenerate()}
                    disabled={isGenerating}
                    className="rounded-full bg-foreground px-5 font-bold text-background hover:bg-foreground/90"
                  >
                    {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    AI 生成尺寸图
                  </Button>
                </div>
              </div>
            ) : (
              <>
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

            {mode === "buyer" ? (
              <div className="mt-3 space-y-3 rounded-2xl border border-border bg-background p-3">
                <div className="grid gap-3 sm:grid-cols-4">
                  <select
                    value={buyerPlatform}
                    onChange={(event) => setBuyerPlatform(event.target.value)}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {buyerPlatforms.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={buyerStyle}
                    onChange={(event) => setBuyerStyle(event.target.value)}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {buyerStyles.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={buyerCount}
                    onChange={(event) => setBuyerCount(Number(event.target.value))}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {buyerCounts.map((option) => (
                      <option key={option} value={option}>
                        {option} 张
                      </option>
                    ))}
                  </select>
                  <select
                    value={buyerRatio}
                    onChange={(event) => setBuyerRatio(event.target.value)}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {buyerRatios.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <select
                    value={buyerHumanMode}
                    onChange={(event) => setBuyerHumanMode(event.target.value)}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {buyerHumanModes.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  <select
                    value={buyerBackgroundMode}
                    onChange={(event) => setBuyerBackgroundMode(event.target.value)}
                    className="h-10 rounded-2xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                    disabled={backgroundImages.length === 0}
                  >
                    {buyerBackgroundModes.map((option) => (
                      <option key={option.id} value={option.id}>
                        背景一致：{option.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                  <div className="rounded-2xl border border-input bg-card px-3 py-2">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>真实度</span>
                      <span className="font-semibold text-foreground">{buyerRealityLevels[buyerReality]}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={3}
                      step={1}
                      value={buyerReality}
                      onChange={(event) => setBuyerReality(Number(event.target.value))}
                      className="mt-1 w-full accent-foreground"
                    />
                  </div>
                  <div className="rounded-2xl border border-input bg-card px-3 py-2 text-xs leading-5 text-muted-foreground">
                    {backgroundImages.length > 0
                      ? "上传背景图后，建议使用“自然变化”：同一空间不同机位，避免每张太像。"
                      : "上传统一背景图后，可选择背景一致程度。"}
                  </div>
                </div>
              </div>
            ) : (
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
            )}

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                value={audience}
                onChange={(event) => setAudience(event.target.value)}
                placeholder="目标人群，例如：宝妈、上班族、送礼人群"
                className="h-10 rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
              />
              <input
                value={mode === "buyer" ? usageScene : priceBand}
                onChange={(event) => (mode === "buyer" ? setUsageScene(event.target.value) : setPriceBand(event.target.value))}
                placeholder={mode === "buyer" ? "使用场景，例如：客厅听歌、通勤穿搭、桌面办公、户外露营" : "价格/定位，例如：中高端、性价比、礼盒款"}
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
                    : mode === "buyer"
                      ? "补充要求，例如：更像手机随手拍、床边自然光、不要文字、参考图同款姿势..."
                      : "补充要求，例如：阴影更轻、产品更居中、保留原始颜色、增加金属质感..."
              }
              className="mt-3 h-10 w-full rounded-2xl border border-input bg-background px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
            />

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              {mode !== "white" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={sameStyle}
                      onChange={(event) => setSameStyle(event.target.checked)}
                      className="size-4 accent-foreground"
                    />
                    {mode === "buyer" ? "同款参考复刻" : "一键同款参考图版式"}
                  </label>
                  {mode === "buyer" ? (
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={buyerConsistentScene}
                        onChange={(event) => setBuyerConsistentScene(event.target.checked)}
                        className="size-4 accent-foreground"
                      />
                      场景保持一致
                    </label>
                  ) : null}
                </div>
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
                {mode === "detail"
                  ? "生成 6 张分页详情页"
                  : mode === "main"
                    ? "复刻 3 张爆款主图"
                    : mode === "buyer"
                      ? `生成 ${buyerCount} 张买家秀`
                      : "生成 2 张白底图"}
              </Button>
            </div>
              </>
            )}
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
                  disabled={
                    isGenerating ||
                    (mode === "resize"
                      ? resizeImages.length === 0 || selectedResizeRatios.length === 0
                      : productImages.length === 0 || !productName.trim())
                  }
                >
                  <RefreshCw className="size-4" />
                  {mode === "resize" ? "重新生成" : "重新生成"}
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
                  const isItemRegenerating =
                    regeneratingItemIds.includes(item.id) || item.status === "queued" || item.status === "running";
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
                          <img
                            src={src}
                            alt={item.title}
                            className="h-full w-full object-cover"
                            onError={(event) => {
                              if (item.imageUrl && event.currentTarget.src !== item.imageUrl) {
                                event.currentTarget.src = item.imageUrl;
                              }
                            }}
                          />
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
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void handleRegenerateItem(item)}
                            disabled={isGenerating || isItemRegenerating}
                            title="单张重新生成"
                            className="inline-flex size-8 items-center justify-center rounded-full bg-secondary text-foreground transition hover:bg-muted disabled:text-muted-foreground"
                          >
                            {isItemRegenerating ? (
                              <LoaderCircle className="size-4 animate-spin" />
                            ) : (
                              <RefreshCw className="size-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => downloadItem(item)}
                            disabled={item.status !== "success"}
                            title="下载"
                            className="inline-flex size-8 items-center justify-center rounded-full bg-foreground text-background disabled:bg-secondary disabled:text-muted-foreground"
                          >
                            <Download className="size-4" />
                          </button>
                        </div>
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
