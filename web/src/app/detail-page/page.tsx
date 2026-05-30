"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Download,
  Layers,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { writePsd } from "ag-psd";
import type { Layer } from "ag-psd";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { createChatCompletion, createImageEditTask, downloadImages, fetchImageTasks, fetchMyIdentity, type ImageTask } from "@/lib/api";
import { parseSkuVariants, type SkuVariant } from "@/lib/sku-variants";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";

type WorkMode = "detail" | "main" | "buyer" | "white" | "resize" | "replace" | "psd" | "sku" | "ab" | "competitor" | "points";
type UploadKind = "product" | "reference" | "background" | "resize";
type JobStatus = "idle" | "queued" | "running" | "success" | "error" | "canceled";

type UploadImage = {
  id: string;
  file: File;
  dataUrl: string;
};

type SkuSlot = {
  id: string;
  name: string;
  spec: string;
  productImages: UploadImage[];
};

type StoredSkuSlot = {
  id: string;
  name: string;
  spec: string;
  productImages: StoredUploadImage[];
};

type SkuReferenceStrength = "loose" | "balanced" | "strict";

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
  referenceFile?: File;
  referenceName?: string;
  extraFiles?: File[];
  groupId?: string;
  groupTitle?: string;
  groupIndex?: number;
};

type PsdLayerPreview = {
  id: string;
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: number;
  canvas: HTMLCanvasElement;
  dataUrl: string;
};

type StoredUploadImage = {
  id: string;
  name: string;
  type: string;
  dataUrl: string;
};

type SkuTaskSpec = SkuVariant & {
  extraFiles: File[];
  referenceStrength: SkuReferenceStrength;
  keepSubject: boolean;
};

type CommerceProject = {
  id: string;
  name: string;
  updatedAt: number;
  mode: WorkMode;
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
  usageScene: string;
  skuText: string;
  skuSharedReferenceImages?: StoredUploadImage[];
  skuSlots?: StoredSkuSlot[];
  productImages: StoredUploadImage[];
  referenceImages: StoredUploadImage[];
  backgroundImages: StoredUploadImage[];
  resizeImages: StoredUploadImage[];
};

type HistoryRecord = {
  id: string;
  createdAt: number;
  mode: WorkMode;
  title: string;
  subtitle: string;
  prompt: string;
  imageUrl: string;
  projectName: string;
};

const platforms = ["淘宝/天猫", "京东", "拼多多", "抖音小店", "小红书", "Amazon"];
const regions = ["中国大陆", "中国港澳台", "东南亚", "北美", "欧洲", "日本", "韩国"];
const languages = ["中文", "英文", "中英双语", "日文", "韩文", "泰文", "越南文"];
const styles = ["高级简洁", "爆款促销", "小红书种草", "科技质感", "母婴温暖", "轻奢礼盒", "极简白底"];
const workModes: Array<{ value: WorkMode; label: string }> = [
  { value: "detail", label: "详情页分页" },
  { value: "main", label: "爆款主图" },
  { value: "buyer", label: "买家秀" },
  { value: "white", label: "白底图" },
  { value: "replace", label: "批量替换主体" },
  { value: "resize", label: "尺寸转换" },
  { value: "sku", label: "批量 SKU 出图" },
  { value: "ab", label: "A/B 测试图" },
  { value: "competitor", label: "竞品图复刻增强" },
];
const PROJECTS_KEY = "chatgpt2api:commerce_projects:v1";
const HISTORY_KEY = "chatgpt2api:commerce_history:v1";
const abVariantPrompts = [
  "A/B 版本策略：强点击大主体，移动端缩略图优先，主体更大更醒目。",
  "A/B 版本策略：高端质感，减少元素，强调材质、光影和品牌感。",
  "A/B 版本策略：促销转化，突出核心利益点和活动氛围，但不夸大宣传。",
  "A/B 版本策略：内容种草，场景更生活化，适合小红书/抖音种草入口。",
  "A/B 版本策略：差异化构图，改变机位、留白和视觉重心，用于点击率测试。",
];
const skuReferenceStrengthOptions: Array<{ value: SkuReferenceStrength; label: string; prompt: string }> = [
  {
    value: "loose",
    label: "低参考",
    prompt: "参考程度：低。只参考参考图中的颜色方向、产品类型和大致质感，不复刻版式、背景、文案、图标、装饰元素或构图，避免与参考图过度相似。",
  },
  {
    value: "balanced",
    label: "中参考",
    prompt: "参考程度：中。参考 SKU 颜色、材质和产品识别特征，但重新设计背景、道具、光影、文案排版和构图，避免直接复刻参考图。",
  },
  {
    value: "strict",
    label: "高参考",
    prompt: "参考程度：高。尽量保持 SKU 颜色、材质、形态和核心卖点一致，但仍必须重做背景、构图、文字、装饰和视觉版式，不能照搬原图。",
  },
];
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
const replaceRatios = ["1:1", "3:4", "4:5", "9:16", "16:9"];
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

async function runWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createSkuSlot(index: number): SkuSlot {
  return {
    id: createId(),
    name: "",
    spec: "",
    productImages: [],
  };
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

function readStoredList<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredList<T>(key: string, value: T) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 忽略本地存储容量不足，不影响出图主流程。
  }
}

function storedImages(images: UploadImage[]): StoredUploadImage[] {
  return images.map((image) => ({
    id: image.id,
    name: image.file.name,
    type: image.file.type || "image/png",
    dataUrl: image.dataUrl,
  }));
}

async function storedToUploadImages(images: StoredUploadImage[]): Promise<UploadImage[]> {
  return Promise.all(
    images.map(async (image) => {
      const response = await fetch(image.dataUrl);
      const blob = await response.blob();
      return {
        id: image.id || createId(),
        file: new File([blob], image.name || "image.png", { type: image.type || blob.type || "image/png" }),
        dataUrl: image.dataUrl,
      };
    }),
  );
}

function parseLines(value: string) {
  return value
    .split(/\r?\n|[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
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

function imageRelFromItem(item: GeneratedItem) {
  const candidates = [item.localImageUrl, item.imageUrl].filter(Boolean) as string[];
  for (const value of candidates) {
    const marker = "/images/";
    const index = value.indexOf(marker);
    if (index >= 0) {
      return value.slice(index + marker.length).replace(/^\/+/, "");
    }
  }
  return "";
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

function buildReplaceItems(
  form: Parameters<typeof basePrompt>[0],
  productImages: UploadImage[],
  referenceImages: UploadImage[],
  size: string,
  keepProductSubject: boolean,
): GeneratedItem[] {
  const base = basePrompt({ ...form, sameStyle: true });
  const productSubjectPrompt = keepProductSubject
    ? "保持产品主体不变：必须把产品图中的商品当作刚性主体完整迁移，不能重绘成相似款，不能改变轮廓、结构、颜色、材质、Logo/纹理位置、零件数量、按钮/接口/花纹和长宽比例；只允许根据参考图环境调整透视、大小、接触阴影、反光和环境光。"
    : "允许在不改变商品识别度的前提下，为适配参考图场景做轻微角度、光影和摆放变化。";
  return productImages.flatMap((product, productIndex) =>
    referenceImages.map((reference, referenceIndex) => ({
      id: createId(),
      title: `替换主体 ${String(productIndex + 1).padStart(2, "0")}-${String(referenceIndex + 1).padStart(2, "0")}`,
      subtitle: `${product.file.name || `产品 ${productIndex + 1}`} / ${reference.file.name || `参考 ${referenceIndex + 1}`}`,
      size,
      prompt: [
        base,
        "",
        "批量替换主体任务：产品图是必须保留的新商品主体，参考图是目标构图、场景、光线、机位、背景、透视、景深、阴影和整体氛围。",
        "请把参考图里的原商品、原主体或同类物体完整替换成产品图里的商品，保持参考图原有背景和画面关系自然可信。",
        productSubjectPrompt,
        "必须严格保留我上传产品的外观、结构、颜色、材质、比例、Logo/纹理位置和关键细节，不要混入参考图原商品的形状、品牌、颜色或装饰。",
        "替换后的产品需要自然融入参考图环境：透视正确、大小合理、接触阴影真实、反光和环境光一致，遮挡关系自然。",
        "不要改变参考图的主要场景、道具、人物姿态、拍摄角度和商业氛围；不要生成海报文字、二维码、水印、虚假品牌 Logo 或无关促销元素。",
        `画面比例必须适配 ${size}。只生成一张替换后的成品图。`,
      ].join("\n"),
      status: "idle" as JobStatus,
      sourceFile: product.file,
      sourceName: product.file.name,
      referenceFile: reference.file,
      referenceName: reference.file.name,
    })),
  );
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
      title: "买家秀 01 上身/使用图",
      subtitle: "真实穿搭/使用状态",
      prompt: "生成上身或使用买家秀：按照真人模式展示商品被真实使用，动作自然，不摆拍，重点看清商品外观和使用方式，像买家真实穿搭或日常使用时随手拍。",
    },
    {
      title: "买家秀 02 场景使用图",
      subtitle: "不同角度使用状态",
      prompt: "生成场景使用买家秀：在同一风格下换一个真实使用角度，展示商品被自然使用的状态，动作和构图区别于第 1 张，重点看清商品外观和使用方式。",
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

function promptEnhancement(options: {
  mode: WorkMode;
  sku: SkuTaskSpec | null;
  abIndex: number;
  competitorStrength: "standard" | "strong" | "strict";
}) {
  const parts: string[] = [];
  if (options.sku) {
    const dimensionText = options.sku.dimensions.length
      ? options.sku.dimensions.map((item) => `${item.name}:${item.value}`).join("；")
      : options.sku.label;
    parts.push([
      `SKU/规格组合：${options.sku.label}。`,
      options.sku.color ? `颜色必须匹配：${options.sku.color}。` : "",
      options.sku.specs.length ? `规格名必须匹配：${options.sku.specs.join("、")}。` : "",
      `维度明细：${dimensionText}。`,
      skuReferenceStrengthOptions.find((item) => item.value === options.sku?.referenceStrength)?.prompt || skuReferenceStrengthOptions[1].prompt,
      options.sku.keepSubject
        ? "保持产品主体不变：必须以本 SKU 上传的对应规格商品图为主体，严格保留商品轮廓、结构、比例、材质、Logo/纹理位置、按键/接口/零件数量和关键细节，只允许围绕该规格做光影、背景、构图和电商视觉优化。"
        : "",
      "本张图必须围绕这个 SKU 生成，保持上传商品的结构、比例、Logo/纹理和关键细节一致，只允许按 SKU 改变颜色、容量、尺寸、包装、配件或文案。",
      "如果提供了统一 SKU 参考图，只参考颜色、材质、产品形态和 SKU 差异点；不要复制参考图的品牌、Logo、水印、文案、排版、背景、道具或完整构图，避免盗图和版权风险。",
      "如果同一批有多个颜色或规格，所有图的构图、视角、光影和背景风格应保持一致，方便作为同一商品 SKU 套图使用。",
    ].filter(Boolean).join("\n"));
  }
  if (options.mode === "competitor" && options.competitorStrength !== "standard") {
    parts.push(options.competitorStrength === "strict"
      ? "竞品图复刻增强：严格解析参考图的主体位置、视角、景别、背景层次、文字区、安全留白、色彩和光影，只替换为我的商品，不复制竞品品牌、Logo、二维码和侵权元素。"
      : "竞品图复刻增强：参考竞品图的构图、视觉重心、光线、道具关系和转化氛围，同时保持我的商品真实一致，规避原品牌和水印。");
  }
  if (options.mode === "ab" && options.abIndex > 0) {
    parts.push(abVariantPrompts[options.abIndex % abVariantPrompts.length]);
  }
  return parts.filter(Boolean).join("\n");
}

function expandProductionItems(
  baseItems: GeneratedItem[],
  options: {
    mode: WorkMode;
    skuText: string;
    skuSpecs?: SkuTaskSpec[];
    skuReferenceStrength?: SkuReferenceStrength;
    abCount: number;
    competitorStrength: "standard" | "strong" | "strict";
  },
) {
  const skuVariants = options.skuSpecs?.length ? options.skuSpecs : parseSkuVariants(options.skuText).map((sku) => ({
    ...sku,
    extraFiles: [],
    referenceStrength: options.skuReferenceStrength || "balanced",
    keepSubject: false,
  }));
  const skuValues = options.mode === "sku" ? (skuVariants.length ? skuVariants : [null]) : [null];
  const abValues = options.mode === "ab" ? Array.from({ length: Math.max(1, Math.min(5, options.abCount)) }, (_, index) => index) : [0];
  const expanded: GeneratedItem[] = [];
  for (const item of baseItems) {
    for (const sku of skuValues) {
      for (const abIndex of abValues) {
        const skuLabel = sku?.label || "";
        const suffix = [skuLabel, options.mode === "ab" && abValues.length > 1 ? `AB${abIndex + 1}` : ""].filter(Boolean);
        const extraPrompt = promptEnhancement({
          mode: options.mode,
          sku,
          abIndex,
          competitorStrength: options.competitorStrength,
        });
        expanded.push({
          ...item,
          id: createId(),
          title: suffix.length ? `${item.title} ${suffix.join(" ")}` : item.title,
          subtitle: suffix.length ? `${item.subtitle} / ${suffix.join(" / ")}` : item.subtitle,
          prompt: extraPrompt ? `${item.prompt}\n\n${extraPrompt}` : item.prompt,
          status: "idle",
          extraFiles: sku?.extraFiles,
        });
      }
    }
  }
  return expanded.slice(0, 40);
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

function safeFileName(value: string) {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 80) || "image";
}

function dosDateTime(date = new Date()) {
  const time =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((date.getFullYear() - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();
  return { time, date: dosDate };
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value: number) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

async function imageSourceToBytes(src: string) {
  const response = await fetch(src);
  if (!response.ok) {
    throw new Error("图片下载失败");
  }
  return new Uint8Array(await response.arrayBuffer());
}

function createZipBlob(files: Array<{ name: string; bytes: Uint8Array }>) {
  const encoder = new TextEncoder();
  const chunks: Array<Uint8Array> = [];
  const central: Array<Uint8Array> = [];
  let offset = 0;
  const stamp = dosDateTime();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const checksum = crc32(file.bytes);
    const local = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...u16(stamp.time),
      ...u16(stamp.date),
      ...u32(checksum),
      ...u32(file.bytes.length),
      ...u32(file.bytes.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
    ]);
    chunks.push(local, file.bytes);
    central.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0x0800),
        ...u16(0),
        ...u16(stamp.time),
        ...u16(stamp.date),
        ...u32(checksum),
        ...u32(file.bytes.length),
        ...u32(file.bytes.length),
        ...u16(nameBytes.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...nameBytes,
      ]),
    );
    offset += local.length + file.bytes.length;
  }

  const centralStart = offset;
  for (const item of central) {
    chunks.push(item);
    offset += item.length;
  }
  chunks.push(
    new Uint8Array([
      ...u32(0x06054b50),
      ...u16(0),
      ...u16(0),
      ...u16(files.length),
      ...u16(files.length),
      ...u32(offset - centralStart),
      ...u32(centralStart),
      ...u16(0),
    ]),
  );

  const blobParts = chunks.map((chunk) => {
    const buffer = new ArrayBuffer(chunk.byteLength);
    new Uint8Array(buffer).set(chunk);
    return buffer;
  });
  return new Blob(blobParts, { type: "application/zip" });
}

async function downloadItemsZip(items: GeneratedItem[], filename: string) {
  const readyItems = items.filter((item) => item.status === "success" && imageSource(item));
  if (readyItems.length === 0) {
    toast.error("请先生成可下载的图片");
    return;
  }
  const files = await Promise.all(
    readyItems.map(async (item, index) => ({
      name: `${String(index + 1).padStart(2, "0")}-${safeFileName(item.title)}.png`,
      bytes: await imageSourceToBytes(imageSource(item)),
    })),
  );
  const blob = createZipBlob(files);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(filename)}.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function imageSourceToCanvas(src: string, width?: number, height?: number) {
  const image = await sourceToDrawable(src);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width || naturalWidth));
  canvas.height = Math.max(1, Math.round(height || naturalHeight));
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("浏览器不支持 PSD 图层合成");
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { canvas, width: canvas.width, height: canvas.height, naturalWidth, naturalHeight };
}

function imageSourceFromTask(task: ImageTask) {
  const first = task.data?.[0];
  if (!first) return "";
  if (first.local_url) return first.local_url;
  if (first.b64_json) return `data:image/png;base64,${first.b64_json}`;
  return first.url || "";
}

function isNearWhite(r: number, g: number, b: number, a: number) {
  if (a < 20) return true;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  return r >= 238 && g >= 238 && b >= 238 && spread <= 28;
}

function removeWhiteBackground(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("浏览器不支持图片拆层");
  }
  context.drawImage(source, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = imageData;
  const background = new Uint8Array(width * height);
  const stack: number[] = [];
  const pushIfBackground = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (background[index]) return;
    const offset = index * 4;
    if (!isNearWhite(data[offset], data[offset + 1], data[offset + 2], data[offset + 3])) return;
    background[index] = 1;
    stack.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    pushIfBackground(x, 0);
    pushIfBackground(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    pushIfBackground(0, y);
    pushIfBackground(width - 1, y);
  }
  while (stack.length) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = Math.floor(index / width);
    pushIfBackground(x + 1, y);
    pushIfBackground(x - 1, y);
    pushIfBackground(x, y + 1);
    pushIfBackground(x, y - 1);
  }
  for (let index = 0; index < background.length; index += 1) {
    if (background[index]) {
      data[index * 4 + 3] = 0;
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas;
}

function applyMaskToOriginal(original: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = original.width;
  canvas.height = original.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("浏览器不支持图片拆层");
  }
  context.drawImage(original, 0, 0);
  const originalData = context.getImageData(0, 0, canvas.width, canvas.height);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = original.width;
  maskCanvas.height = original.height;
  const maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskContext) {
    throw new Error("浏览器不支持图片拆层");
  }
  maskContext.drawImage(mask, 0, 0, original.width, original.height);
  const maskData = maskContext.getImageData(0, 0, original.width, original.height);

  for (let offset = 0; offset < originalData.data.length; offset += 4) {
    const maskR = maskData.data[offset];
    const maskG = maskData.data[offset + 1];
    const maskB = maskData.data[offset + 2];
    const maskA = maskData.data[offset + 3];
    if (maskA < 28 || isNearWhite(maskR, maskG, maskB, maskA)) {
      originalData.data[offset + 3] = 0;
    }
  }
  context.putImageData(originalData, 0, 0);
  return removeWhiteBackground(canvas);
}

function splitCanvasIntoLayers(source: HTMLCanvasElement, baseName: string, strength: "soft" | "normal" | "strong" = "normal") {
  const context = source.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("浏览器不支持图片拆层");
  }
  const width = source.width;
  const height = source.height;
  const imageData = context.getImageData(0, 0, width, height);
  const { data } = imageData;
  const visited = new Uint8Array(width * height);
  const minPixelRatio = strength === "strong" ? 0.00012 : strength === "soft" ? 0.0008 : 0.00035;
  const minPixels = Math.max(strength === "strong" ? 24 : 80, Math.floor(width * height * minPixelRatio));
  const components: Array<{ pixels: number[]; left: number; top: number; right: number; bottom: number }> = [];

  const isSolid = (index: number) => data[index * 4 + 3] > 28;
  for (let start = 0; start < visited.length; start += 1) {
    if (visited[start] || !isSolid(start)) continue;
    const stack = [start];
    const pixels: number[] = [];
    visited[start] = 1;
    let left = start % width;
    let right = left;
    let top = Math.floor(start / width);
    let bottom = top;
    while (stack.length) {
      const index = stack.pop() as number;
      pixels.push(index);
      const x = index % width;
      const y = Math.floor(index / width);
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      const neighbors = [index + 1, index - 1, index + width, index - width];
      for (const next of neighbors) {
        if (next < 0 || next >= visited.length || visited[next] || !isSolid(next)) continue;
        const nx = next % width;
        const ny = Math.floor(next / width);
        if (Math.abs(nx - x) + Math.abs(ny - y) !== 1) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }
    if (pixels.length >= minPixels) {
      components.push({ pixels, left, top, right, bottom });
    }
  }

  const sorted = components
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .slice(0, strength === "strong" ? 64 : strength === "soft" ? 20 : 32);

  const layers = sorted.map((component, index) => {
    const layerWidth = component.right - component.left + 1;
    const layerHeight = component.bottom - component.top + 1;
    const canvas = document.createElement("canvas");
    canvas.width = layerWidth;
    canvas.height = layerHeight;
    const layerContext = canvas.getContext("2d");
    if (!layerContext) {
      throw new Error("浏览器不支持 PSD 图层合成");
    }
    const layerData = layerContext.createImageData(layerWidth, layerHeight);
    for (const pixel of component.pixels) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const sourceOffset = pixel * 4;
      const targetOffset = ((y - component.top) * layerWidth + (x - component.left)) * 4;
      layerData.data[targetOffset] = data[sourceOffset];
      layerData.data[targetOffset + 1] = data[sourceOffset + 1];
      layerData.data[targetOffset + 2] = data[sourceOffset + 2];
      layerData.data[targetOffset + 3] = data[sourceOffset + 3];
    }
    layerContext.putImageData(layerData, 0, 0);
    return {
      id: createId(),
      name: `${String(index + 1).padStart(2, "0")}-${baseName}`,
      left: component.left,
      top: component.top,
      width: layerWidth,
      height: layerHeight,
      pixels: component.pixels.length,
      canvas,
      dataUrl: canvas.toDataURL("image/png"),
    };
  });

  if (layers.length === 0) {
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    const layerContext = canvas.getContext("2d");
    if (!layerContext) {
      throw new Error("浏览器不支持 PSD 图层合成");
    }
    layerContext.drawImage(source, 0, 0);
    layers.push({
      id: createId(),
      name: `01-${baseName}`,
      left: 0,
      top: 0,
      width: source.width,
      height: source.height,
      pixels: source.width * source.height,
      canvas,
      dataUrl: canvas.toDataURL("image/png"),
    });
  }

  return layers;
}

function createPsdBlobFromLayers(layers: PsdLayerPreview[], width: number, height: number) {
  const psdLayers: Layer[] = layers.map((layer) => ({
    name: layer.name,
    top: layer.top,
    left: layer.left,
    bottom: layer.top + layer.height,
    right: layer.left + layer.width,
    canvas: layer.canvas,
  }));
  const buffer = writePsd({
    width,
    height,
    children: psdLayers,
  });
  return new Blob([buffer], { type: "image/vnd.adobe.photoshop" });
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

function FeaturePanel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border bg-background p-3">
      <div className="mb-3">
        <div className="text-sm font-semibold text-foreground">{title}</div>
        {description ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{description}</div> : null}
      </div>
      {children}
    </section>
  );
}

export default function DetailPageGenerator() {
  const { isCheckingAuth, session } = useAuthGuard();
  const productInputRef = useRef<HTMLInputElement>(null);
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  const resizeInputRef = useRef<HTMLInputElement>(null);
  const skuUploadInputRef = useRef<HTMLInputElement>(null);
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
  const [replaceRatio, setReplaceRatio] = useState("1:1");
  const [replaceKeepProductSubject, setReplaceKeepProductSubject] = useState(true);
  const [items, setItems] = useState<GeneratedItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [regeneratingItemIds, setRegeneratingItemIds] = useState<string[]>([]);
  const [selectedResizeRatios, setSelectedResizeRatios] = useState<string[]>([]);
  const [psdLayers, setPsdLayers] = useState<PsdLayerPreview[]>([]);
  const [psdCanvasSize, setPsdCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [projectName, setProjectName] = useState("");
  const [projects, setProjects] = useState<CommerceProject[]>(() => readStoredList<CommerceProject[]>(PROJECTS_KEY, []));
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>(() => readStoredList<HistoryRecord[]>(HISTORY_KEY, []));
  const [skuText, setSkuText] = useState("");
  const [skuSharedReferenceImages, setSkuSharedReferenceImages] = useState<UploadImage[]>([]);
  const [skuReferenceStrength, setSkuReferenceStrength] = useState<SkuReferenceStrength>("balanced");
  const [skuKeepSubject, setSkuKeepSubject] = useState(true);
  const [skuSlots, setSkuSlots] = useState<SkuSlot[]>(() => [createSkuSlot(0)]);
  const [abCount, setAbCount] = useState(2);
  const [competitorStrength, setCompetitorStrength] = useState<"standard" | "strong" | "strict">("strong");
  const [psdSplitStrength, setPsdSplitStrength] = useState<"soft" | "normal" | "strong">("normal");
  const [historyCompareIds, setHistoryCompareIds] = useState<string[]>([]);
  const [isExtractingPoints, setIsExtractingPoints] = useState(false);
  const [commercePermissions, setCommercePermissions] = useState<string[] | null>(null);

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
  const skuTaskSpecs = useMemo<SkuTaskSpec[]>(() => {
    const specs: SkuTaskSpec[] = [];
    skuSlots.forEach((slot, index) => {
      const name = slot.name.trim();
      const spec = slot.spec.trim();
      const hasAnyValue =
        name ||
        spec ||
        slot.productImages.length > 0;
      if (!hasAnyValue) {
        return;
      }
      const label = [name || `SKU ${index + 1}`, spec].filter(Boolean).join(" ");
      specs.push({
        label,
        raw: label,
        color: name || undefined,
        specs: spec ? [spec] : [],
        dimensions: [
          name ? { name: "颜色/SKU", value: name } : null,
          spec ? { name: "规格", value: spec } : null,
        ].filter((item): item is { name: string; value: string } => Boolean(item)),
        extraFiles: [
          ...slot.productImages.map((image) => image.file),
          ...skuSharedReferenceImages.map((image) => image.file),
        ],
        referenceStrength: skuReferenceStrength,
        keepSubject: skuKeepSubject,
      });
    });
    return specs.slice(0, 6);
  }, [skuKeepSubject, skuReferenceStrength, skuSharedReferenceImages, skuSlots]);
  const totalCount =
    mode === "detail"
      ? 6
      : mode === "main"
        ? 2
        : mode === "buyer"
          ? buyerCount
          : mode === "white"
            ? 2
            : mode === "replace"
              ? productImages.length * referenceImages.length
              : mode === "sku"
                ? Math.max(1, skuTaskSpecs.length)
                : mode === "ab"
                  ? Math.max(1, Math.min(5, abCount))
                  : mode === "competitor"
                    ? 2
                    : mode === "points"
                      ? 1
              : mode === "psd"
                ? resizeImages.length
              : resizeImages.length * selectedResizeRatios.length;
  const canStitchDetail =
    mode === "detail" && items.length === 6 && items.every((item) => item.status === "success" && imageSource(item));
  const canDownloadZip = items.some((item) => item.status === "success" && imageSource(item));
  const visibleModes = workModes.filter((item) => session?.role === "admin" || commercePermissions === null || commercePermissions.includes(item.value));
  const currentModeAllowed = session?.role === "admin" || commercePermissions === null || commercePermissions.includes(mode);

  useEffect(() => {
    let active = true;
    void fetchMyIdentity()
      .then((data) => {
        if (!active) return;
        const permissions = data.identity.role === "admin" ? workModes.map((item) => item.value) : data.identity.commerce_permissions ?? [];
        setCommercePermissions(permissions);
        if (!permissions.includes(mode)) {
          setMode((permissions[0] as WorkMode | undefined) ?? "detail");
          setItems([]);
        }
      })
      .catch(() => {
        if (active) setCommercePermissions([]);
      });
    return () => {
      active = false;
    };
  }, [mode]);

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
      setResizeImages((prev) => (mode === "psd" ? images.slice(0, 1) : [...prev, ...images].slice(0, 20)));
      if (mode === "psd") {
        setPsdLayers([]);
        setPsdCanvasSize(null);
      }
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
      if (mode === "psd") {
        setPsdLayers([]);
        setPsdCanvasSize(null);
      }
    }
  };

  const addSkuImages = async (files: File[]) => {
    const images = await filesToUploadImages(files);
    if (images.length === 0) return;
    setSkuSharedReferenceImages((prev) => [...prev, ...images].slice(0, 6));
  };

  const updateSkuSlot = (id: string, updates: Partial<Pick<SkuSlot, "name" | "spec">>) => {
    setSkuSlots((prev) => prev.map((slot) => (slot.id === id ? { ...slot, ...updates } : slot)));
  };

  const addSkuSlot = () => {
    setSkuSlots((prev) => (prev.length >= 6 ? prev : [...prev, createSkuSlot(prev.length)]));
  };

  const removeSkuSlot = (slotId: string) => {
    setSkuSlots((prev) => (prev.length <= 1 ? prev : prev.filter((slot) => slot.id !== slotId)));
  };

  const addSkuProductImages = async (slotId: string, files: File[]) => {
    const images = await filesToUploadImages(files);
    if (images.length === 0) return;
    setSkuSlots((prev) =>
      prev.map((slot) => (
        slot.id === slotId
          ? { ...slot, productImages: [...slot.productImages, ...images].slice(0, 6) }
          : slot
      )),
    );
  };

  const removeSkuProductImage = (slotId: string, imageId: string) => {
    setSkuSlots((prev) =>
      prev.map((slot) => (
        slot.id === slotId
          ? { ...slot, productImages: slot.productImages.filter((image) => image.id !== imageId) }
          : slot
      )),
    );
  };

  const updateItem = (id: string, updater: (item: GeneratedItem) => GeneratedItem) => {
    setItems((prev) => prev.map((item) => (item.id === id ? updater(item) : item)));
  };

  const appendHistory = (records: GeneratedItem[]) => {
    const successful = records
      .filter((item) => item.status === "success" && imageSource(item))
      .map((item) => ({
        id: createId(),
        createdAt: Date.now(),
        mode,
        title: item.title,
        subtitle: item.subtitle,
        prompt: item.prompt,
        imageUrl: imageSource(item),
        projectName: projectName.trim() || productName.trim() || "未命名项目",
      }));
    if (!successful.length) return;
    setHistoryRecords((prev) => {
      const next = [...successful, ...prev].slice(0, 80);
      writeStoredList(HISTORY_KEY, next);
      return next;
    });
  };

  const runItemTask = async (item: GeneratedItem) => {
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
        mode === "detail"
          ? "detail"
          : mode === "main"
            ? "main"
            : mode === "buyer"
              ? "buyer"
              : mode === "white"
                ? "white"
                : mode === "replace"
                  ? "replace"
                  : mode === "sku"
                    ? "sku"
                    : mode === "ab"
                      ? "ab"
                      : mode === "competitor"
                        ? "competitor"
                  : "resize";
      const taskId = `${taskPrefix}-${createId()}`;
      const taskFiles =
        mode === "resize"
          ? item.sourceFile
            ? [item.sourceFile]
            : []
          : mode === "replace"
            ? [item.sourceFile, item.referenceFile].filter((file): file is File => Boolean(file))
          : mode === "white"
            ? productImages.map((image) => image.file)
            : mode === "buyer"
              ? buyerFiles
            : mode === "sku"
              ? item.extraFiles || []
            : allFiles;
      const taskGroup = item.groupId
        ? {
            group_id: item.groupId,
            group_title: item.groupTitle || `${productName.trim() || "电商出图"} 批量任务`,
            group_index: item.groupIndex ?? 0,
          }
        : undefined;
      const submitted = await createImageEditTask(taskId, taskFiles, item.prompt, "gpt-image-2", item.size, taskGroup, mode);
      updateItem(item.id, (current) => applyTaskToItem(current, submitted));
      const finished = await pollTask(submitted.id);
      const nextItem = applyTaskToItem(item, finished);
      updateItem(item.id, () => nextItem);
      return nextItem;
    } catch (error) {
      const failedItem = {
        ...item,
        status: "error",
        error: error instanceof Error ? error.message : "生成失败",
      } as GeneratedItem;
      updateItem(item.id, () => failedItem);
      return failedItem;
    }
  };

  const handleGenerate = async () => {
    if (!currentModeAllowed) {
      toast.error("当前账号没有这个电商功能权限，请联系管理员开启");
      return;
    }
    if (mode === "points") {
      await handleExtractSellingPoints();
      return;
    }
    if (mode === "psd") {
      await handleDownloadUploadedPsd();
      return;
    }
    if (mode === "resize") {
      if (resizeImages.length === 0) {
        toast.error("请先上传需要 AI 改比例的图片");
        return;
      }
      if (selectedResizeRatios.length === 0) {
        toast.error("请选择至少一个比例");
        return;
      }
      const groupId = `resize-${createId()}`;
      const nextItems = buildResizeItems(resizeImages, selectedResizeRatios).map((item, index) => ({
        ...item,
        groupId,
        groupTitle: `${productName.trim() || "图片"} 尺寸转换`,
        groupIndex: index,
      }));
      setItems(nextItems);
      setIsGenerating(true);
      try {
        const results = await runWithConcurrency(nextItems, 2, (item) => runItemTask(item));
        appendHistory(results);
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
    if (mode !== "sku" && productImages.length === 0) {
      toast.error("请至少上传一张商品图");
      return;
    }
    if ((mode === "main" || mode === "replace" || mode === "competitor") && referenceImages.length === 0) {
      toast.error(mode === "replace" ? "请上传需要替换主体的参考图" : "请上传参考图");
      return;
    }
    if (mode === "sku" && skuTaskSpecs.length === 0) {
      toast.error("请先填写至少 1 个 SKU，最多一次生成 6 个颜色/规格");
      return;
    }
    if (mode === "sku" && skuSlots.some((slot) => (slot.name.trim() || slot.spec.trim()) && slot.productImages.length === 0)) {
      toast.error("每个已填写的 SKU 都需要上传对应规格商品图");
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
    const baseItems =
      mode === "detail"
        ? buildDetailItems(form, "3:4")
        : mode === "main"
          ? buildMainItems(form, "1:1").slice(0, 2)
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
            : mode === "replace"
              ? buildReplaceItems(form, productImages, referenceImages, replaceRatio, replaceKeepProductSubject)
              : mode === "sku"
                ? buildMainItems(form, "1:1").slice(0, 1)
                : mode === "ab"
                  ? buildMainItems(form, "1:1").slice(0, 1)
                  : mode === "competitor"
                    ? buildMainItems(form, "1:1").slice(0, 2)
              : buildWhiteItems(form, "1:1");
    const nextItems = expandProductionItems(baseItems, {
      mode,
      skuText,
      skuSpecs: skuTaskSpecs,
      skuReferenceStrength,
      abCount,
      competitorStrength,
    });
    const groupId = `${mode}-${createId()}`;
    const groupTitle =
      mode === "sku"
        ? `${normalizedProductName} 批量 SKU`
        : mode === "detail"
          ? `${normalizedProductName} 详情页`
          : mode === "ab"
            ? `${normalizedProductName} A/B 测试图`
            : mode === "competitor"
              ? `${normalizedProductName} 竞品图复刻`
              : `${normalizedProductName} 电商出图`;
    const groupedItems = nextItems.map((item, index) => ({
      ...item,
      groupId,
      groupTitle,
      groupIndex: index,
    }));
    setItems(groupedItems);
    setIsGenerating(true);
    try {
      const results = await runWithConcurrency(groupedItems, mode === "sku" ? 2 : 3, (item) => runItemTask(item));
      appendHistory(results);
      toast.success(
        mode === "detail"
          ? "6 张分页详情页生成流程已结束"
          : mode === "main"
            ? "爆款主图复刻生成流程已结束"
            : mode === "buyer"
              ? "买家秀生成流程已结束"
            : mode === "replace"
              ? "批量替换主体生成流程已结束"
              : mode === "sku"
                ? "批量 SKU 出图流程已结束"
                : mode === "ab"
                  ? "A/B 测试图生成流程已结束"
                  : mode === "competitor"
                    ? "竞品图复刻增强流程已结束"
                : "白底图生成流程已结束",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleModeChange = (nextMode: WorkMode) => {
    if (session?.role !== "admin" && commercePermissions !== null && !commercePermissions.includes(nextMode)) {
      toast.error("当前账号没有这个电商功能权限，请联系管理员开启");
      return;
    }
    setMode(nextMode);
    setItems([]);
    setRegeneratingItemIds([]);
    setPsdLayers([]);
    setPsdCanvasSize(null);
    if (nextMode === "psd") {
      setResizeImages((prev) => prev.slice(0, 1));
    }
  };

  const handleSaveProject = () => {
    const name = projectName.trim() || productName.trim() || "未命名套图";
    const project: CommerceProject = {
      id: createId(),
      name,
      updatedAt: Date.now(),
      mode,
      productName,
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
      skuText,
      skuSharedReferenceImages: storedImages(skuSharedReferenceImages),
      skuSlots: skuSlots.map((slot) => ({
        id: slot.id,
        name: slot.name,
        spec: slot.spec,
        productImages: storedImages(slot.productImages),
      })),
      productImages: storedImages(productImages),
      referenceImages: storedImages(referenceImages),
      backgroundImages: storedImages(backgroundImages),
      resizeImages: storedImages(resizeImages),
    };
    setProjects((prev) => {
      const next = [project, ...prev.filter((item) => item.name !== name)].slice(0, 24);
      writeStoredList(PROJECTS_KEY, next);
      return next;
    });
    setProjectName(name);
    toast.success("套图项目已保存");
  };

  const handleLoadProject = async (id: string) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    setMode(project.mode);
    setProjectName(project.name);
    setProductName(project.productName);
    setCategory(project.category);
    setSellingPoints(project.sellingPoints);
    setPlatform(project.platform);
    setRegion(project.region);
    setLanguage(project.language);
    setStyle(project.style);
    setAudience(project.audience);
    setPriceBand(project.priceBand);
    setExtra(project.extra);
    setUsageScene(project.usageScene);
    setSkuText(project.skuText || "");
    const legacyReferenceImages = (project.skuSlots || [])
      .flatMap((slot) => Array.isArray((slot as StoredSkuSlot & { referenceImages?: StoredUploadImage[] }).referenceImages)
        ? ((slot as StoredSkuSlot & { referenceImages?: StoredUploadImage[] }).referenceImages || [])
        : []);
    setSkuSharedReferenceImages(await storedToUploadImages([
      ...(project.skuSharedReferenceImages || []),
      ...legacyReferenceImages,
    ].slice(0, 6)));
    const loadedSkuSlots = await Promise.all(
      (project.skuSlots || []).slice(0, 6).map(async (slot, index) => ({
        id: slot.id || createId(),
        name: slot.name || "",
        spec: slot.spec || "",
        productImages: await storedToUploadImages(slot.productImages || []),
      })),
    );
    setSkuSlots(loadedSkuSlots.length ? loadedSkuSlots.slice(0, 6) : [createSkuSlot(0)]);
    setProductImages(await storedToUploadImages(project.productImages || []));
    setReferenceImages(await storedToUploadImages(project.referenceImages || []));
    setBackgroundImages(await storedToUploadImages(project.backgroundImages || []));
    setResizeImages(await storedToUploadImages(project.resizeImages || []));
    setItems([]);
    setPsdLayers([]);
    setPsdCanvasSize(null);
    toast.success("套图项目已载入");
  };

  const handleExtractSellingPoints = async () => {
    if (session?.role !== "admin" && commercePermissions !== null && !commercePermissions.includes("points")) {
      toast.error("当前账号没有商品卖点提炼权限，请联系管理员开启");
      return;
    }
    const source = [productName, category, sellingPoints, extra].filter(Boolean).join("\n");
    if (!source.trim() && productImages.length === 0) {
      toast.error("请先输入商品信息或上传商品图");
      return;
    }
    setIsExtractingPoints(true);
    try {
      const data = await createChatCompletion(
        [
          {
            role: "user",
            content: `请为电商出图提炼商品卖点，输出 5 条短卖点，每条 8-16 个中文字符，适合主图使用。商品信息：\n${source || "请根据商品图片常规卖点提炼"}`,
          },
        ],
        "auto",
        { commerceFeature: "points" },
      );
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("没有返回卖点");
      setSellingPoints(text);
      toast.success("商品卖点已提炼");
    } catch (error) {
      const fallback = parseLines(source).slice(0, 5).join("\n") || "高清质感\n多场景适用\n细节精致\n使用便捷\n送礼自用皆宜";
      setSellingPoints(fallback);
      toast.error(error instanceof Error ? `AI 提炼失败，已用本地规则生成：${error.message}` : "AI 提炼失败，已用本地规则生成");
    } finally {
      setIsExtractingPoints(false);
    }
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

  const handleDownloadZip = async () => {
    const zipName =
      mode === "detail"
        ? "详情页分页图"
        : mode === "main"
          ? "爆款主图"
          : mode === "buyer"
            ? "买家秀"
            : mode === "white"
              ? "白底图"
              : mode === "replace"
                ? "批量替换主体"
                : "尺寸转换图";
    try {
      await downloadItemsZip(items, `${productName.trim() || zipName}-${zipName}`);
      toast.success("已打包下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打包下载失败");
    }
  };

  const handleDownloadZipSmart = async () => {
    const zipName =
      mode === "detail"
        ? "详情页分页图"
        : mode === "main"
          ? "爆款主图"
          : mode === "buyer"
            ? "买家秀"
            : mode === "white"
              ? "白底图"
              : mode === "replace"
                ? "批量替换主体"
                : "尺寸转换图";
    const filename = `${safeFileName(`${productName.trim() || zipName}-${zipName}`)}.zip`;
    const rels = items
      .filter((item) => item.status === "success")
      .map(imageRelFromItem)
      .filter(Boolean);
    try {
      if (rels.length > 0) {
        try {
          await downloadImages(rels, filename);
          toast.success("已一键压缩下载");
          return;
        } catch {
          // 旧任务或跨域图片取不到服务器路径时，继续用浏览器端兜底打包。
        }
      }
      await downloadItemsZip(items, `${productName.trim() || zipName}-${zipName}`);
      toast.success("已一键压缩下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "压缩下载失败");
    }
  };

  const handleDownloadUploadedPsd = async () => {
    const source = resizeImages[0];
    if (!source) {
      toast.error("请先上传要拆分的图片");
      return;
    }
    if (psdLayers.length > 0 && psdCanvasSize) {
      const baseName = safeFileName(source.file.name.replace(/\.[^.]+$/, "") || "元素");
      const blob = createPsdBlobFromLayers(psdLayers, psdCanvasSize.width, psdCanvasSize.height);
      downloadBlob(blob, `${safeFileName(`${productName.trim() || baseName}-PSD分层源文件`)}.psd`);
      toast.success(`PSD 格式分层源文件已导出，共 ${psdLayers.length} 个图层`);
      return;
    }
    setIsGenerating(true);
    try {
      setPsdLayers([]);
      setPsdCanvasSize(null);
      const prompt = [
        "为上传的电商成品图生成 PSD 拆层用透明遮罩。",
        "只去除纯白或近白背景，保留商品、文字、装饰图形、图标、阴影、贴纸等所有可见元素。",
        "不要重新设计，不要移动、缩放、裁切任何元素，不要增删文字，不要改变商品外观。",
        "输出与原图构图一致的透明背景 PNG，元素边缘干净，用于按原始坐标拆成 Photoshop 图层。",
      ].join("\n");
      const submitted = await createImageEditTask(`psd-split-${createId()}`, source.file, prompt, "gpt-image-2", undefined, undefined, "psd");
      const finished = await pollTask(submitted.id);
      if (finished.status !== "success") {
        throw new Error(finished.error || "AI 拆层预处理失败");
      }
      const src = imageSourceFromTask(finished);
      if (!src) {
        throw new Error("AI 未返回可处理图片");
      }
      const original = await imageSourceToCanvas(source.dataUrl);
      const mask = await imageSourceToCanvas(src, original.width, original.height);
      const transparent = applyMaskToOriginal(original.canvas, mask.canvas);
      const baseName = safeFileName(source.file.name.replace(/\.[^.]+$/, "") || "元素");
      const layers = splitCanvasIntoLayers(transparent, baseName, psdSplitStrength);
      setPsdLayers(layers);
      setPsdCanvasSize({ width: original.width, height: original.height });
      const blob = createPsdBlobFromLayers(layers, original.width, original.height);
      downloadBlob(blob, `${safeFileName(`${productName.trim() || baseName}-PSD分层源文件`)}.psd`);
      toast.success(`PSD 格式分层源文件已导出，共 ${layers.length} 个图层`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "PSD 导出失败");
    } finally {
      setIsGenerating(false);
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
    } else if (mode === "replace") {
      if (!item.sourceFile || !item.referenceFile) {
        toast.error("这张图的产品图或参考图不存在，请重新上传");
        return;
      }
    } else if (mode !== "sku" && productImages.length === 0) {
      toast.error("请先保留至少一张商品图");
      return;
    } else if (mode === "sku" && (!item.extraFiles || item.extraFiles.length === 0)) {
      toast.error("这张 SKU 图缺少对应规格商品图，请重新生成整批");
      return;
    }

    setRegeneratingItemIds((prev) => [...prev, item.id]);
    try {
      const nextItem = await runItemTask(item);
      if (nextItem.status === "success") {
        appendHistory([nextItem]);
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
          : mode === "replace"
            ? "批量替换主体"
            : mode === "psd"
              ? "图片转 PSD"
              : mode === "sku"
                ? "批量 SKU 出图"
                : mode === "ab"
                  ? "A/B 测试图"
                  : mode === "competitor"
                    ? "竞品图复刻增强"
                    : mode === "points"
                      ? "商品卖点提炼"
            : "尺寸转换";
  const pageSubTitle =
    mode === "detail"
      ? "上传商品，一键生成 6 张分页详情页"
      : mode === "main"
        ? "上传爆款参考图，一键复刻 2 张主图"
        : mode === "buyer"
          ? "上传商品图和买家秀参考图，一键生成真实晒单图片"
          : mode === "white"
          ? "上传商品图，一键生成精修白底图和 3D 白底图"
          : mode === "replace"
            ? "上传多张自己的产品和参考图，批量把参考图主体替换成你的产品"
            : mode === "psd"
              ? "上传成品图，AI 去白底并拆分元素，生成 PSD 格式分层源文件"
              : mode === "sku"
                ? "输入多个颜色、规格或型号，一键批量生成对应商品图"
                : mode === "ab"
                  ? "围绕同一商品生成多版主图，用于点击率测试"
                  : mode === "competitor"
                    ? "上传竞品参考图，增强复刻构图、光影和转化氛围"
                    : mode === "points"
                      ? "根据商品信息自动提炼适合主图和详情页使用的短卖点"
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
          : mode === "replace"
            ? "参考图，上传需要替换主体的图片"
            : mode === "competitor"
              ? "竞品参考图，上传需要复刻增强的图片"
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
          : mode === "replace"
            ? "批量替换主体结果"
            : mode === "psd"
              ? "PSD 源文件图层预览"
              : mode === "sku"
                ? "批量 SKU 出图结果"
                : mode === "ab"
                  ? "A/B 测试图结果"
                  : mode === "competitor"
                    ? "竞品图复刻增强结果"
                    : mode === "points"
                      ? "商品卖点提炼结果"
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
          : mode === "replace"
            ? "上传自己的产品图和参考图后，批量把参考图里的主体替换成自己的产品。"
            : mode === "psd"
              ? "上传一张成品图后，AI 会去除白底并识别画面元素，生成可在 Photoshop 编辑的 PSD 分层源文件。"
              : mode === "sku"
                ? "填写批量 SKU 并上传商品图后，一键生成每个 SKU 对应图片。"
                : mode === "ab"
                  ? "设置 A/B 版本数量并上传商品图后，一键生成多版测试图。"
                  : mode === "competitor"
                    ? "上传商品图和竞品参考图后，生成规避品牌元素的复刻增强图。"
                    : mode === "points"
                      ? "输入商品信息后点击提炼卖点，结果会写入商品卖点输入框。"
            : "上传图片并选择比例后，点击 AI 生成尺寸图。";
  const productUploadTitle = mode === "replace" ? "自己的产品图，支持多张批量替换" : "商品图，多角度上传";

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
      <input
        ref={skuUploadInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          void addSkuImages(Array.from(event.target.files || []));
          event.currentTarget.value = "";
        }}
      />

      <section className="mx-auto grid w-full max-w-[1520px] gap-6 px-4 py-6 lg:grid-cols-[minmax(520px,0.92fr)_minmax(560px,1.08fr)] lg:px-8">
        <div className="space-y-4">
          {["resize", "psd", "sku", "ab", "points"].includes(mode) ? null : (
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
            <div className="mb-4 flex max-w-full flex-wrap gap-1 rounded-[24px] bg-secondary p-1">
              {visibleModes.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => handleModeChange(value)}
                  className={cn(
                    "h-9 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition",
                    mode === value ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {commercePermissions?.length === 0 && session.role !== "admin" ? (
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                当前账号还没有电商区功能权限，请联系管理员在后台开启。
              </div>
            ) : null}

            <div className="mb-4 space-y-3">
              {mode === "sku" ? (
                <FeaturePanel title="批量 SKU 出图" description="默认 1 个 SKU，按需求新增到最多 6 个。这里只填写颜色/规格名；统一参考图支持设置参考程度，避免照搬造成版权风险。">
                  <div className="space-y-4">
                    <div className="rounded-2xl border border-border bg-card p-3">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold">统一 SKU 参考图</div>
                          <div className="text-xs leading-5 text-muted-foreground">应用到本批所有 SKU，只参考颜色、材质和产品差异点。</div>
                        </div>
                        <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
                          SKU {skuSlots.length}/6
                        </span>
                      </div>
                      <UploadStrip
                        title="统一 SKU 参考图/颜色图"
                        images={skuSharedReferenceImages}
                        onPick={() => skuUploadInputRef.current?.click()}
                        onRemove={(id) => setSkuSharedReferenceImages((prev) => prev.filter((image) => image.id !== id))}
                      />
                      <div className="mt-3">
                        <div className="mb-2 text-xs font-semibold text-muted-foreground">参考程度</div>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {skuReferenceStrengthOptions.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setSkuReferenceStrength(option.value)}
                              className={cn(
                                "h-9 rounded-xl border px-3 text-sm font-semibold transition",
                                skuReferenceStrength === option.value
                                  ? "border-foreground bg-foreground text-background"
                                  : "border-border bg-background text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className="mt-3 flex w-fit cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm font-semibold text-foreground">
                        <input
                          type="checkbox"
                          checked={skuKeepSubject}
                          onChange={(event) => setSkuKeepSubject(event.target.checked)}
                          className="size-4 accent-foreground"
                        />
                        保持产品主体不变
                      </label>
                    </div>

                    <div className="grid gap-3">
                      {skuSlots.map((slot, index) => (
                        <div key={slot.id} className="rounded-2xl border border-border bg-background p-3">
                          <div className="mb-3 flex items-center justify-between">
                            <div className="text-sm font-semibold">SKU {index + 1}</div>
                            {skuSlots.length > 1 ? (
                              <button
                                type="button"
                                onClick={() => removeSkuSlot(slot.id)}
                                className="rounded-full bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
                              >
                                删除
                              </button>
                            ) : null}
                          </div>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <input
                              value={slot.name}
                              onChange={(event) => updateSkuSlot(slot.id, { name: event.target.value })}
                              placeholder="颜色/SKU 名称，例如：黑色、白色、蓝色"
                              className="h-10 rounded-xl border border-input bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
                            />
                            <input
                              value={slot.spec}
                              onChange={(event) => updateSkuSlot(slot.id, { spec: event.target.value })}
                              placeholder="规格，例如：64G、礼盒款、XL"
                              className="h-10 rounded-xl border border-input bg-card px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground"
                            />
                          </div>
                          <div className="mt-3">
                            <input
                              id={`sku-product-${slot.id}`}
                              type="file"
                              accept="image/*"
                              multiple
                              className="hidden"
                              onChange={(event) => {
                                void addSkuProductImages(slot.id, Array.from(event.target.files || []));
                                event.currentTarget.value = "";
                              }}
                            />
                            <UploadStrip
                              title="对应规格商品图"
                              images={slot.productImages}
                              onPick={() => document.getElementById(`sku-product-${slot.id}`)?.click()}
                              onRemove={(id) => removeSkuProductImage(slot.id, id)}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                    {skuSlots.length < 6 ? (
                      <button
                        type="button"
                        onClick={addSkuSlot}
                        className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-background text-sm font-semibold text-foreground transition hover:bg-secondary"
                      >
                        <Plus className="size-4" />
                        新增 SKU
                      </button>
                    ) : null}
                  </div>
                </FeaturePanel>
              ) : mode === "ab" ? (
                <FeaturePanel title="A/B 测试图" description="为同一商品生成多个差异化构图版本，用于点击率测试。">
                  <select
                    value={abCount}
                    onChange={(event) => setAbCount(Number(event.target.value))}
                    className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    {[1, 2, 3, 4, 5].map((count) => (
                      <option key={count} value={count}>A/B {count} 版</option>
                    ))}
                  </select>
                </FeaturePanel>
              ) : mode === "competitor" ? (
                <FeaturePanel title="竞品图复刻增强" description="复刻参考图构图、光影、留白和转化氛围，但规避原品牌、水印和侵权元素。">
                  <select
                    value={competitorStrength}
                    onChange={(event) => setCompetitorStrength(event.target.value as "standard" | "strong" | "strict")}
                    className="h-10 w-full rounded-xl border border-input bg-card px-3 text-sm outline-none focus:border-foreground"
                  >
                    <option value="standard">标准复刻</option>
                    <option value="strong">增强复刻</option>
                    <option value="strict">严格复刻</option>
                  </select>
                </FeaturePanel>
              ) : mode === "psd" ? (
                <FeaturePanel title="图片转 PSD 深度优化" description="上传成品图后去除白底，按元素拆成独立图层，并保留每个元素在原图中的相对位置。">
                  <div className="flex flex-wrap items-center gap-2">
                    {[
                      ["soft", "弱：合并小元素"],
                      ["normal", "中：常规拆分"],
                      ["strong", "强：拆更多细节"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setPsdSplitStrength(value as "soft" | "normal" | "strong")}
                        className={cn(
                          "h-8 rounded-full border px-3 text-xs font-semibold transition",
                          psdSplitStrength === value ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </FeaturePanel>
              ) : null}
            </div>

            {mode === "resize" || mode === "psd" ? (
              <div className="space-y-4">
                <UploadStrip
                  title={mode === "psd" ? "上传成品图，AI 拆分元素生成 PSD 分层源文件" : "上传图片，支持多张批量改尺寸"}
                  images={resizeImages}
                  onPick={() => resizeInputRef.current?.click()}
                  onRemove={(id) => removeImage("resize", id)}
                />

                {mode === "resize" ? (
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
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    {mode === "psd" ? "AI 会先去除白底，再把识别到的独立元素拆成 Photoshop 图层。" : "AI 会智能扩图补背景，不会简单拉伸变形。"}
                  </div>
                  <Button
                    type="button"
                    onClick={() => void handleGenerate()}
                    disabled={isGenerating || !currentModeAllowed}
                    className="rounded-full bg-foreground px-5 font-bold text-background hover:bg-foreground/90"
                  >
                    {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : mode === "psd" ? <Layers className="size-4" /> : <Sparkles className="size-4" />}
                    {mode === "psd" ? "AI 拆层生成 PSD" : "AI 生成尺寸图"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {mode === "sku" ? null : (
                  <UploadStrip
                    title={productUploadTitle}
                    images={productImages}
                    onPick={() => productInputRef.current?.click()}
                    onRemove={(id) => removeImage("product", id)}
                  />
                )}

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

            {mode === "replace" ? (
              <div className="mt-3 rounded-2xl border border-border bg-background p-3">
                <div className="mb-2 text-sm font-semibold">输出比例</div>
                <div className="flex flex-wrap gap-2">
                  {replaceRatios.map((option) => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setReplaceRatio(option)}
                      className={cn(
                        "h-9 rounded-full border px-4 text-sm font-semibold transition",
                        replaceRatio === option
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-card text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {option}
                    </button>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  建议按参考图比例选择，生成时会尽量保留参考图构图和场景，只替换主体产品。
                </div>
              </div>
            ) : null}

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
                    {mode === "buyer" ? "同款参考复刻" : mode === "replace" ? "保留参考图构图场景" : "一键同款参考图版式"}
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
                  {mode === "replace" ? (
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-secondary px-3 py-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={replaceKeepProductSubject}
                        onChange={(event) => setReplaceKeepProductSubject(event.target.checked)}
                        className="size-4 accent-foreground"
                      />
                      保持产品主体不变
                    </label>
                  ) : null}
                </div>
              ) : (
                <span />
              )}
              <Button
                type="button"
                onClick={() => void handleGenerate()}
                disabled={isGenerating || !currentModeAllowed}
                className="rounded-full bg-foreground px-5 font-bold text-background hover:bg-foreground/90"
              >
                {isGenerating ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                {mode === "detail"
                  ? "生成 6 张分页详情页"
                  : mode === "main"
                    ? "复刻 2 张爆款主图"
                    : mode === "buyer"
                      ? `生成 ${buyerCount} 张买家秀`
                      : mode === "replace"
                        ? productImages.length > 0 && referenceImages.length > 0
                          ? `批量替换 ${productImages.length * referenceImages.length} 张`
                          : "批量替换主体"
                        : mode === "sku"
                          ? "批量 SKU 出图"
                          : mode === "ab"
                            ? `生成 A/B ${abCount} 版`
                            : mode === "competitor"
                              ? "生成竞品复刻图"
                              : mode === "points"
                                ? "提炼商品卖点"
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

          {historyRecords.length ? (
            <div className="rounded-[24px] border border-border bg-card p-3 shadow-sm">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="text-sm font-semibold">出图历史 / 版本对比</div>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setHistoryRecords([]);
                    setHistoryCompareIds([]);
                    writeStoredList(HISTORY_KEY, []);
                  }}
                >
                  清空历史
                </button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {[0, 1].map((slot) => (
                  <select
                    key={slot}
                    value={historyCompareIds[slot] || ""}
                    onChange={(event) => {
                      const next = [...historyCompareIds];
                      next[slot] = event.target.value;
                      setHistoryCompareIds(next.filter(Boolean).slice(0, 2));
                    }}
                    className="h-9 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-foreground"
                  >
                    <option value="">选择版本 {slot + 1}</option>
                    {historyRecords.slice(0, 30).map((record) => (
                      <option key={record.id} value={record.id}>
                        {record.title} / {new Date(record.createdAt).toLocaleString("zh-CN")}
                      </option>
                    ))}
                  </select>
                ))}
              </div>
              {historyCompareIds.length ? (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {historyCompareIds.map((id) => {
                    const record = historyRecords.find((item) => item.id === id);
                    if (!record) return null;
                    return (
                      <div key={record.id} className="overflow-hidden rounded-xl border border-border bg-background">
                        <div className="truncate px-2 py-1.5 text-xs font-semibold">{record.title}</div>
                        <div className="aspect-square bg-muted">
                          <img src={record.imageUrl} alt={record.title} className="h-full w-full object-contain" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="rounded-[28px] border border-border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="text-sm font-semibold">{resultTitle}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {mode === "psd" ? `源图 ${resizeImages.length ? "已上传" : "未上传"}${psdLayers.length ? `，已拆 ${psdLayers.length} 层` : ""}` : `完成 ${completeCount}/${totalCount}${activeCount > 0 ? `，生成中 ${activeCount}` : ""}`}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {mode === "psd" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-border bg-background text-foreground hover:bg-secondary"
                    onClick={() => void handleDownloadUploadedPsd()}
                    disabled={resizeImages.length === 0}
                  >
                    <Layers className="size-4" />
                    {psdLayers.length ? "下载 PSD" : "AI 拆层"}
                  </Button>
                ) : mode === "detail" ? (
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
                {mode !== "psd" ? (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-border bg-background text-foreground hover:bg-secondary"
                      onClick={() => void handleDownloadZipSmart()}
                      disabled={!canDownloadZip}
                    >
                      <Download className="size-4" />
                      打包下载
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-full border-border bg-background text-foreground hover:bg-secondary"
                      onClick={() => void handleGenerate()}
                      disabled={
                        isGenerating ||
                        (mode === "resize"
                          ? resizeImages.length === 0 || selectedResizeRatios.length === 0
                          : (mode !== "sku" && productImages.length === 0) ||
                            !productName.trim() ||
                            ((mode === "main" || mode === "replace") && referenceImages.length === 0))
                      }
                    >
                      <RefreshCw className="size-4" />
                      重新生成
                    </Button>
                  </>
                ) : null}
              </div>
            </div>

            <div className="grid gap-3 p-3 sm:grid-cols-2">
              {mode === "psd" && isGenerating ? (
                <div className="col-span-full grid min-h-[520px] place-items-center text-center text-sm text-muted-foreground">
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="size-4 animate-spin" />
                    AI 正在去白底并拆分图像元素...
                  </span>
                </div>
              ) : mode === "psd" && psdLayers.length > 0 ? (
                psdLayers.map((layer) => (
                  <div key={layer.id} className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{layer.name}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          x {layer.left} / y {layer.top} / {layer.width}x{layer.height}
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-1 text-xs text-emerald-700">图层</span>
                    </div>
                    <div className="aspect-square bg-muted">
                      <img src={layer.dataUrl} alt={layer.name} className="h-full w-full object-contain" />
                    </div>
                  </div>
                ))
              ) : mode === "psd" && resizeImages.length > 0 ? (
                <div className="col-span-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                  <div className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">源图</div>
                      <div className="truncate text-xs text-muted-foreground">{resizeImages[0].file.name}</div>
                    </div>
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-1 text-xs text-muted-foreground">等待 AI 拆层</span>
                  </div>
                  <div className="aspect-video bg-muted">
                    <img src={resizeImages[0].dataUrl} alt={resizeImages[0].file.name} className="h-full w-full object-contain" />
                  </div>
                </div>
              ) : items.length === 0 ? (
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
