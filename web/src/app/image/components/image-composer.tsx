"use client";
import { ArrowUp, Check, ChevronDown, CornerDownRight, ImagePlus, Infinity as InfinityIcon, LoaderCircle, ShoppingBag, Sparkles, X } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type RefObject,
} from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

type SizeOption = { value: string; label: string; desc: string; w: number; h: number };
const SIZE_OPTIONS: SizeOption[] = [
  { value: "", label: "未指定", desc: "由模型自动决定", w: 0, h: 0 },
  { value: "1:1", label: "1:1", desc: "正方形", w: 22, h: 22 },
  { value: "16:9", label: "16:9", desc: "横版", w: 28, h: 16 },
  { value: "4:3", label: "4:3", desc: "横版", w: 24, h: 18 },
  { value: "3:4", label: "3:4", desc: "竖版", w: 18, h: 24 },
  { value: "9:16", label: "9:16", desc: "竖版", w: 16, h: 28 },
];

type ReplyTarget = {
  sourcePrompt: string;
  aiMessage: string;
};

type CommerceTemplateId = "main" | "detail" | "scene" | "white" | "feature" | "compare" | "promo";
type CommerceDraft = {
  template: CommerceTemplateId;
  product: string;
  category: string;
  sellingPoints: string;
  platform: string;
  audience: string;
  style: string;
  background: string;
  constraints: string;
};

export type CommerceSuitePrompt = {
  title: string;
  prompt: string;
  size: string;
};

const COMMERCE_STORAGE_KEY = "image-commerce-draft";
let commerceStorageTimer: number | null = null;
const COMMERCE_PLATFORMS = ["淘宝/天猫", "京东", "拼多多", "抖音小店", "小红书", "Amazon"];
const COMMERCE_STYLES = ["高级简洁", "白底质感", "直播爆款", "国潮氛围", "科技冷感", "温暖生活方式", "轻奢礼盒"];
const COMMERCE_TEMPLATES: Array<{
  id: CommerceTemplateId;
  label: string;
  size: string;
  goal: string;
  structure: string;
}> = [
  {
    id: "main",
    label: "主图",
    size: "1:1",
    goal: "适合电商列表页的高点击商品主图",
    structure: "商品居中占画面 70%-85%，主体清晰，光线干净，突出核心卖点，预留少量平台安全边距",
  },
  {
    id: "detail",
    label: "详情页首屏",
    size: "3:4",
    goal: "详情页首屏视觉，先建立信任和购买欲",
    structure: "上方强视觉商品展示，中段展示 3-5 个核心卖点，下方保留参数或使用场景区域",
  },
  {
    id: "scene",
    label: "场景图",
    size: "4:3",
    goal: "把商品放进真实使用场景，增强代入感",
    structure: "自然场景、真实透视、商品仍是视觉中心，搭配道具服务于卖点",
  },
  {
    id: "white",
    label: "白底图",
    size: "1:1",
    goal: "平台审核友好的干净白底商品图",
    structure: "纯白或浅灰背景，完整商品轮廓，柔和投影，避免多余装饰",
  },
  {
    id: "feature",
    label: "卖点细节",
    size: "1:1",
    goal: "突出材质、工艺、功能或局部细节",
    structure: "微距或半剖视角，局部放大，清楚展示质感和功能点",
  },
  {
    id: "compare",
    label: "对比图",
    size: "16:9",
    goal: "展示升级前后、普通款与本商品的差异",
    structure: "左右对比构图，差异明确，保持真实可信，避免夸张虚假效果",
  },
  {
    id: "promo",
    label: "活动促销",
    size: "1:1",
    goal: "适合大促、上新、节日活动的商品氛围图",
    structure: "商品主视觉明确，加入节日或活动氛围，留出可后期加价格和活动文案的位置",
  },
];

const DEFAULT_COMMERCE_DRAFT: CommerceDraft = {
  template: "main",
  product: "",
  category: "",
  sellingPoints: "",
  platform: "淘宝/天猫",
  audience: "",
  style: "高级简洁",
  background: "",
  constraints: "不要生成虚假品牌、平台水印、二维码、乱码文字；产品结构和材质要真实可信；画面可直接用于电商上架。",
};

function optimizeImagePrompt(prompt: string, hasReferenceImages: boolean) {
  const text = prompt.trim();
  if (!text) {
    return "";
  }
  const lower = text.toLowerCase();
  const hasStructure =
    text.includes("构图") ||
    text.includes("光线") ||
    text.includes("背景") ||
    text.includes("细节") ||
    lower.includes("composition") ||
    lower.includes("lighting");
  if (hasStructure) {
    return text;
  }
  const modeHint = hasReferenceImages
    ? "保持参考图的产品主体、结构比例和核心特征不变，只优化画面质感、构图、光线和背景。"
    : "主体清晰完整，构图稳定，画面有明确视觉焦点。";
  return [
    text,
    "",
    "优化后的画图要求：",
    modeHint,
    "电商级真实质感，干净高级的商业摄影风格，细节锐利，材质真实，光线柔和自然。",
    "背景简洁不抢主体，避免杂乱元素，保留适合后期排版的安全留白。",
    "不要生成乱码文字、畸形结构、多余手指、多余配件、变形边缘或低清晰度效果。",
  ].join("\n");
}

function buildCommercePrompt(draft: CommerceDraft) {
  const template = COMMERCE_TEMPLATES.find((item) => item.id === draft.template) ?? COMMERCE_TEMPLATES[0];
  const lines = [
    `请生成一张${draft.platform}电商${template.label}，用途：${template.goal}。`,
    draft.product ? `商品：${draft.product}` : "商品：根据参考图保持商品外观、结构、颜色和材质一致",
    draft.category ? `类目：${draft.category}` : "",
    draft.sellingPoints ? `核心卖点：${draft.sellingPoints}` : "",
    draft.audience ? `目标人群：${draft.audience}` : "",
    `视觉风格：${draft.style}`,
    draft.background ? `背景/场景：${draft.background}` : "",
    `构图要求：${template.structure}`,
    "质感要求：高清商业摄影，干净布光，细节锐利，色彩准确，产品边缘清楚，适合移动端首屏快速识别。",
    draft.constraints ? `限制：${draft.constraints}` : "",
  ];

  return lines.filter(Boolean).join("\n");
}

function buildCommerceDetailSuitePrompts(draft: CommerceDraft): CommerceSuitePrompt[] {
  const product = draft.product.trim() || "参考图中的商品";
  const category = draft.category.trim() || "电商商品";
  const sellingPoints = draft.sellingPoints.trim() || "根据参考图提炼外观、材质、功能、使用价值和购买理由";
  const audience = draft.audience.trim() || "目标消费者";
  const background = draft.background.trim() || "干净高级的商业摄影场景";
  const constraints =
    draft.constraints.trim() ||
    "不要生成虚假品牌、平台水印、二维码、乱码文字；产品结构和材质要真实可信；画面可直接用于电商上架。";
  const base = [
    `商品：${product}`,
    `类目：${category}`,
    `平台：${draft.platform}`,
    `目标人群：${audience}`,
    `核心卖点：${sellingPoints}`,
    `统一视觉风格：${draft.style}`,
    `统一限制：${constraints}`,
    "必须严格参考上传的产品图，保持商品外观、颜色、结构、材质、比例和关键细节一致。",
    "高清电商商业摄影，移动端详情页可用，画面干净，产品主体清楚，避免不可读小字和夸张虚假效果。",
  ].join("\n");

  return [
    {
      title: "01 首屏利益点",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 01：首屏主视觉。\n画面目标：让用户第一眼知道这是什么商品、适合谁、最大购买理由是什么。\n构图：商品作为主视觉，占画面 60%-75%，背景为${background}，留出顶部和底部安全空间，整体高级、清爽、有点击欲。\n信息表达：围绕最强卖点做视觉化表达，不要生成乱码文字；如需文字区域，只保留干净留白，方便后期加文案。`,
    },
    {
      title: "02 核心卖点",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 02：核心卖点总览。\n画面目标：把 3-5 个核心卖点转化为清晰的视觉符号和分区展示。\n构图：中心保留完整商品，周围用简洁分区、图标感元素、局部示意来表达卖点；不要出现难以阅读的小字。\n重点：卖点要真实可信，突出购买理由，适合详情页第二屏承接首屏。`,
    },
    {
      title: "03 使用场景",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 03：真实使用场景。\n画面目标：让买家代入使用后的生活状态或工作场景。\n构图：商品自然出现在${background}或更贴近${audience}的真实场景中，透视自然，主体仍然突出。\n重点：场景要服务于卖点，不要让道具喧宾夺主，画面要像真实电商详情页摄影。`,
    },
    {
      title: "04 材质细节",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 04：材质和工艺细节。\n画面目标：用近景、微距、局部放大展示质感、做工、接口、纹理、缝线、边缘或关键结构。\n构图：可采用主商品 + 2-3 个局部放大窗口的版式，细节真实锐利，光线柔和。\n重点：不要改变产品真实结构，不虚构不存在的功能。`,
    },
    {
      title: "05 对比说明",
      size: "16:9",
      prompt: `${base}\n\n生成详情页模块 05：差异对比图。\n画面目标：表达本商品相对普通产品的优势，例如质感、容量、便携、效率、舒适度、包装或使用体验。\n构图：左右对比或上下对比，左侧为普通/旧体验的弱化示意，右侧为本商品的高级清晰展示。\n重点：对比要克制可信，不要做医疗、绝对化、夸大承诺。`,
    },
    {
      title: "06 参数包装",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 06：规格、包装、配件或尺寸感。\n画面目标：帮助用户理解商品大小、包装质感、配件组成和送礼属性。\n构图：商品、包装盒、配件或尺度参照整齐排列，背景干净，留出可后期添加参数文案的区域。\n重点：如果参考图没有配件，不要虚构复杂配件；可用抽象尺寸线和留白表达。`,
    },
    {
      title: "07 收尾转化",
      size: "3:4",
      prompt: `${base}\n\n生成详情页模块 07：结尾转化氛围图。\n画面目标：作为详情页末屏，强化品牌感、品质感和下单欲望。\n构图：商品以精致静物摄影方式呈现，背景为${background}，氛围温和、有质感，适合放置售后、保障、立即购买等后期文案。\n重点：画面完整、干净、统一，和前面模块像同一套详情页。`,
    },
  ];
}

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  availableQuota: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  replyTarget?: ReplyTarget | null;
  onCancelReply?: () => void;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
  onGenerateCommerceSuite: (payload: {
    productName: string;
    prompts: CommerceSuitePrompt[];
  }) => void | Promise<void>;
  onSubmit: () => void | Promise<void>;
  onPickReferenceImage: () => void;
  onReferenceImageChange: (files: File[]) => void | Promise<void>;
  onRemoveReferenceImage: (index: number) => void;
};

export function ImageComposer({
  prompt,
  imageCount,
  imageSize,
  availableQuota,
  activeTaskCount,
  referenceImages,
  textareaRef,
  fileInputRef,
  replyTarget,
  onCancelReply,
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
  onGenerateCommerceSuite,
  onSubmit,
  onPickReferenceImage,
  onReferenceImageChange,
  onRemoveReferenceImage,
}: ImageComposerProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [isSizeMenuOpen, setIsSizeMenuOpen] = useState(false);
  const [sizeMenuPos, setSizeMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [isCountMenuOpen, setIsCountMenuOpen] = useState(false);
  const [countMenuPos, setCountMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isCommerceOpen, setIsCommerceOpen] = useState(false);
  const [commerceDraft, setCommerceDraft] = useState<CommerceDraft>(DEFAULT_COMMERCE_DRAFT);
  const dragCounterRef = useRef(0);
  const sizeMenuRef = useRef<HTMLDivElement>(null);
  const sizeMenuBtnRef = useRef<HTMLButtonElement>(null);
  const countMenuRef = useRef<HTMLDivElement>(null);
  const countMenuBtnRef = useRef<HTMLButtonElement>(null);
  const lightboxImages = useMemo(
    () => referenceImages.map((image, index) => ({ id: `${image.name}-${index}`, src: image.dataUrl })),
    [referenceImages],
  );
  const selectedSize = SIZE_OPTIONS.find((option) => option.value === imageSize) ?? SIZE_OPTIONS[0];
  const parsedCount = Math.max(1, Math.min(8, Number(imageCount) || 1));
  const selectedCommerceTemplate =
    COMMERCE_TEMPLATES.find((template) => template.id === commerceDraft.template) ?? COMMERCE_TEMPLATES[0];

  useEffect(() => {
    try {
      const rawDraft = window.localStorage.getItem(COMMERCE_STORAGE_KEY);
      if (!rawDraft) {
        return;
      }
      setCommerceDraft({ ...DEFAULT_COMMERCE_DRAFT, ...JSON.parse(rawDraft) });
    } catch {
      window.localStorage.removeItem(COMMERCE_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (commerceStorageTimer) {
      window.clearTimeout(commerceStorageTimer);
    }
    commerceStorageTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(COMMERCE_STORAGE_KEY, JSON.stringify(commerceDraft));
      } catch {
        // localStorage may be blocked or full.
      }
      commerceStorageTimer = null;
    }, 300);
    return () => {
      if (commerceStorageTimer) {
        window.clearTimeout(commerceStorageTimer);
        commerceStorageTimer = null;
      }
    };
  }, [commerceDraft]);

  const updateCommerceDraft = <Key extends keyof CommerceDraft>(key: Key, value: CommerceDraft[Key]) => {
    setCommerceDraft((draft) => ({ ...draft, [key]: value }));
  };

  const applyCommercePrompt = (mode: "append" | "replace") => {
    const nextPrompt = buildCommercePrompt(commerceDraft);
    onPromptChange(mode === "append" && prompt.trim() ? `${prompt.trim()}\n\n${nextPrompt}` : nextPrompt);
    if (selectedCommerceTemplate.size) {
      onImageSizeChange(selectedCommerceTemplate.size);
    }
    textareaRef.current?.focus();
  };

  const generateCommerceSuite = () => {
    void onGenerateCommerceSuite({
      productName: commerceDraft.product.trim(),
      prompts: buildCommerceDetailSuitePrompts(commerceDraft),
    });
  };

  useEffect(() => {
    if (!isSizeMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!sizeMenuRef.current?.contains(event.target as Node)) {
        setIsSizeMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isSizeMenuOpen]);

  useEffect(() => {
    if (!isCountMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!countMenuRef.current?.contains(event.target as Node)) {
        setIsCountMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [isCountMenuOpen]);

  const handleTextareaPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  const hasImageItem = (event: DragEvent<HTMLDivElement>) => {
    const items = event.dataTransfer?.items;
    if (items && items.length > 0) {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item.kind === "file" && item.type.startsWith("image/")) {
          return true;
        }
      }
      return false;
    }
    // Fallback：某些浏览器在 dragenter 阶段无法读 items.type，按 file 类型放行
    return Array.from(event.dataTransfer?.types || []).includes("Files");
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasImageItem(event)) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDraggingOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasImageItem(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (dragCounterRef.current === 0) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    dragCounterRef.current = 0;
    setIsDraggingOver(false);
    const imageFiles = Array.from(event.dataTransfer?.files || []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    void onReferenceImageChange(imageFiles);
  };

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div className="relative" style={{ width: "min(980px, 100%)" }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void onReferenceImageChange(Array.from(event.target.files || []));
          }}
        />

        {/* 缩略图行用 absolute 浮在 composer 输入框正上方，不占文档高度。
            否则空状态下加参考图会让 composer 区从 ~200px 长到 ~280px，
            results (flex-1) 被压缩 ~80px，items-center 居中的 hero 文案就被顶上去了。
            外层 relative 由父级 image-composer wrapper 提供（rounded-[28px] bg-white 那块）。
            移动端 (sm 以下) 横向滚动；桌面端 sm: 起 flex-wrap。 */}
        {referenceImages.length > 0 && !replyTarget ? (
          <div className="pointer-events-none absolute right-1 bottom-full left-1 z-10 sm:right-0 sm:left-0">
            <div className="pointer-events-auto mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
              {referenceImages.map((image, index) => (
                <div key={`${image.name}-${index}`} className="relative size-14 shrink-0 sm:size-16">
                  <button
                    type="button"
                    onClick={() => {
                      setLightboxIndex(index);
                      setLightboxOpen(true);
                    }}
                    className="group size-14 overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 transition hover:border-stone-300 sm:size-16"
                    aria-label={`预览参考图 ${image.name || index + 1}`}
                  >
                    <img
                      src={image.dataUrl}
                      alt={image.name || `参考图 ${index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onRemoveReferenceImage(index);
                    }}
                    className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-300 hover:text-stone-800"
                    aria-label={`移除参考图 ${image.name || index + 1}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div
          className={cn(
            "relative overflow-hidden rounded-[28px] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_4px_24px_rgba(15,23,42,0.08)] transition sm:rounded-[32px]",
            isDraggingOver && "ring-2 ring-stone-900/70 ring-offset-2 ring-offset-white",
          )}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div
            className="relative cursor-text"
            onClick={() => {
              textareaRef.current?.focus();
            }}
          >
            <ImageLightbox
              images={lightboxImages}
              currentIndex={lightboxIndex}
              open={lightboxOpen}
              onOpenChange={setLightboxOpen}
              onIndexChange={setLightboxIndex}
            />
            {replyTarget ? (
              <div
                className="mx-3 mt-3 flex items-start gap-2 rounded-2xl border border-stone-200/80 bg-stone-50/80 px-3 py-2 sm:mx-5 sm:mt-4"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-white text-stone-500 ring-1 ring-stone-200">
                  <CornerDownRight className="size-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-stone-500">
                    <span>正在回复 AI 的提问</span>
                    <span className="text-stone-300">·</span>
                    <span className="text-stone-400">无需粘贴原文，模型会自动收到上下文</span>
                  </div>
                  {replyTarget.aiMessage ? (
                    <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-stone-600 sm:text-[13px]">
                      {replyTarget.aiMessage}
                    </p>
                  ) : null}
                </div>
                {onCancelReply ? (
                  <button
                    type="button"
                    onClick={onCancelReply}
                    className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-stone-400 transition hover:bg-stone-200 hover:text-stone-700"
                    aria-label="取消回复"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            ) : null}
            <div className="hidden" onClick={(event) => event.stopPropagation()}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setIsCommerceOpen((open) => !open)}
                  className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-full bg-white px-3 text-[12px] font-semibold text-emerald-900 ring-1 ring-emerald-100 transition hover:bg-emerald-50 sm:text-[13px]"
                >
                  <ShoppingBag className="size-3.5" />
                  电商工具箱
                  <ChevronDown className={cn("size-3.5 opacity-60 transition", isCommerceOpen && "rotate-180")} />
                </button>
                <div className="flex min-w-0 flex-1 justify-end gap-1.5 overflow-x-auto">
                  {COMMERCE_TEMPLATES.slice(0, 5).map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => {
                        updateCommerceDraft("template", template.id);
                        onImageSizeChange(template.size);
                      }}
                      className={cn(
                        "h-8 shrink-0 cursor-pointer rounded-full px-3 text-[12px] font-medium transition",
                        commerceDraft.template === template.id
                          ? "bg-emerald-900 text-white"
                          : "bg-white text-emerald-800 ring-1 ring-emerald-100 hover:bg-emerald-50",
                      )}
                    >
                      {template.label}
                    </button>
                  ))}
                </div>
              </div>
              {isCommerceOpen ? (
                <div className="mt-3 grid gap-2 border-t border-emerald-100 pt-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={commerceDraft.product}
                      onChange={(event) => updateCommerceDraft("product", event.target.value)}
                      placeholder="商品名，例如：无线筋膜枪 Pro"
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                    />
                    <input
                      value={commerceDraft.category}
                      onChange={(event) => updateCommerceDraft("category", event.target.value)}
                      placeholder="类目，例如：家用按摩器/小家电/女装"
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                    />
                  </div>
                  <textarea
                    value={commerceDraft.sellingPoints}
                    onChange={(event) => updateCommerceDraft("sellingPoints", event.target.value)}
                    placeholder="核心卖点：轻量便携、长续航、静音、礼盒包装、适合送礼..."
                    rows={2}
                    className="min-h-16 resize-none rounded-xl border border-emerald-100 bg-white px-3 py-2 text-[13px] leading-5 text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                  />
                  <div className="grid gap-2 sm:grid-cols-3">
                    <select
                      value={commerceDraft.platform}
                      onChange={(event) => updateCommerceDraft("platform", event.target.value)}
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition focus:border-emerald-300"
                    >
                      {COMMERCE_PLATFORMS.map((platform) => (
                        <option key={platform} value={platform}>
                          {platform}
                        </option>
                      ))}
                    </select>
                    <select
                      value={commerceDraft.style}
                      onChange={(event) => updateCommerceDraft("style", event.target.value)}
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition focus:border-emerald-300"
                    >
                      {COMMERCE_STYLES.map((style) => (
                        <option key={style} value={style}>
                          {style}
                        </option>
                      ))}
                    </select>
                    <select
                      value={commerceDraft.template}
                      onChange={(event) => {
                        const templateId = event.target.value as CommerceTemplateId;
                        const template = COMMERCE_TEMPLATES.find((item) => item.id === templateId);
                        updateCommerceDraft("template", templateId);
                        if (template?.size) {
                          onImageSizeChange(template.size);
                        }
                      }}
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition focus:border-emerald-300"
                    >
                      {COMMERCE_TEMPLATES.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={commerceDraft.audience}
                      onChange={(event) => updateCommerceDraft("audience", event.target.value)}
                      placeholder="目标人群，例如：通勤女性/宝妈/办公室人群"
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                    />
                    <input
                      value={commerceDraft.background}
                      onChange={(event) => updateCommerceDraft("background", event.target.value)}
                      placeholder="背景场景，例如：浅灰影棚/卧室床头/厨房台面"
                      className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                    />
                  </div>
                  <input
                    value={commerceDraft.constraints}
                    onChange={(event) => updateCommerceDraft("constraints", event.target.value)}
                    placeholder="限制条件"
                    className="h-9 rounded-xl border border-emerald-100 bg-white px-3 text-[13px] text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-300"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="inline-flex items-center gap-1.5 text-[12px] text-emerald-800">
                      <Sparkles className="size-3.5" />
                      当前模板会自动使用 {selectedCommerceTemplate.size || "默认"} 比例
                    </div>
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        onClick={generateCommerceSuite}
                        className="h-9 cursor-pointer rounded-full bg-amber-500 px-4 text-[13px] font-semibold text-white transition hover:bg-amber-600"
                      >
                        一键详情页套图
                      </button>
                      <button
                        type="button"
                        onClick={() => applyCommercePrompt("append")}
                        className="h-9 cursor-pointer rounded-full bg-white px-4 text-[13px] font-semibold text-emerald-900 ring-1 ring-emerald-100 transition hover:bg-emerald-50"
                      >
                        追加提示词
                      </button>
                      <button
                        type="button"
                        onClick={() => applyCommercePrompt("replace")}
                        className="h-9 cursor-pointer rounded-full bg-emerald-900 px-4 text-[13px] font-semibold text-white transition hover:bg-emerald-800"
                      >
                        替换提示词
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                replyTarget
                  ? "输入你的回答…"
                  : referenceImages.length > 0
                    ? "描述你希望如何修改参考图"
                    : "输入你想要生成的画面，也可直接粘贴图片"
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void onSubmit();
                }
              }}
              className="min-h-[82px] resize-none rounded-[24px] border-0 bg-transparent px-4 pt-4 pb-2 text-[15px] leading-6 text-stone-900 shadow-none placeholder:text-stone-400 focus-visible:ring-0 sm:min-h-[148px] sm:rounded-[32px] sm:px-6 sm:pt-6 sm:pb-20 sm:leading-7"
            />

            <div className="rounded-b-[24px] border-t border-stone-100 bg-white px-3 pb-3 pt-2 sm:absolute sm:inset-x-0 sm:bottom-0 sm:rounded-b-none sm:border-t-0 sm:bg-gradient-to-t sm:from-white sm:via-white/95 sm:to-transparent sm:px-6 sm:pb-4 sm:pt-6" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-end justify-between gap-2 sm:gap-3">
                <div className="hide-scrollbar flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto pb-0.5 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:pb-0">
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-stone-100 px-3 text-[12px] font-medium text-stone-700 transition hover:bg-stone-200 sm:h-10 sm:gap-2 sm:px-4 sm:text-[13px]"
                    onClick={onPickReferenceImage}
                    aria-label={referenceImages.length > 0 ? "添加参考图" : "上传参考图"}
                  >
                    <ImagePlus className="size-3.5 sm:size-4" strokeWidth={2} />
                    <span>{referenceImages.length > 0 ? "添加" : "上传"}</span>
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-stone-100 px-3 text-[12px] font-medium text-stone-700 transition hover:bg-stone-200 disabled:cursor-not-allowed disabled:text-stone-300 sm:h-10 sm:gap-2 sm:px-4 sm:text-[13px]"
                    onClick={() => {
                      const nextPrompt = optimizeImagePrompt(prompt, referenceImages.length > 0);
                      if (!nextPrompt || nextPrompt === prompt.trim()) {
                        return;
                      }
                      onPromptChange(nextPrompt);
                    }}
                    disabled={!prompt.trim()}
                    aria-label="优化提示词"
                    title="优化提示词"
                  >
                    <Sparkles className="size-3.5 sm:size-4" strokeWidth={2} />
                    <span>优化</span>
                  </button>
                  <span className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-stone-100 px-3 text-[12px] font-medium text-stone-500 sm:h-10 sm:px-3.5 sm:text-[13px]">
                    <span className="hidden sm:inline">剩余</span>
                    {availableQuota === "∞" ? (
                      <InfinityIcon className="size-3.5 text-stone-900 sm:size-4" strokeWidth={2.25} aria-label="不限额度" />
                    ) : (
                      <span className="font-data tabular-nums text-stone-900">{availableQuota}</span>
                    )}
                  </span>
                  {activeTaskCount > 0 && (
                    <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-amber-50 px-3 text-[12px] font-medium text-amber-700 ring-1 ring-amber-100 sm:h-10 sm:px-3.5 sm:text-[13px]">
                      <LoaderCircle className="size-3.5 animate-spin" strokeWidth={2.25} />
                      <span className="font-data tabular-nums">{activeTaskCount}</span>
                      <span className="hidden sm:inline">处理中</span>
                    </span>
                  )}
                  <div className="relative shrink-0">
                    <button
                      ref={countMenuBtnRef}
                      type="button"
                      className={cn(
                        "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition sm:h-10 sm:gap-2 sm:px-4 sm:text-[13px]",
                        isCountMenuOpen
                          ? "bg-stone-900 text-white"
                          : "bg-stone-100 text-stone-700 hover:bg-stone-200",
                      )}
                      onClick={() => {
                        if (!isCountMenuOpen && countMenuBtnRef.current) {
                          const rect = countMenuBtnRef.current.getBoundingClientRect();
                          const menuWidth = Math.min(212, window.innerWidth - 32);
                          setCountMenuPos({
                            top: rect.top - 8,
                            left: Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16)),
                          });
                        }
                        setIsCountMenuOpen((open) => !open);
                      }}
                    >
                      <span className={cn("hidden sm:inline", isCountMenuOpen ? "text-white/70" : "text-stone-500")}>张数</span>
                      <span className="font-data tabular-nums">{parsedCount}</span>
                      <ChevronDown
                        className={cn(
                          "size-3.5 shrink-0 opacity-60 transition",
                          isCountMenuOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {isCountMenuOpen ? (
                      <div
                        ref={countMenuRef}
                        className="fixed z-[80] rounded-2xl border border-stone-200/70 bg-white p-2 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_24px_48px_-16px_rgba(15,23,42,0.18)]"
                        style={{
                          top: countMenuPos.top,
                          left: countMenuPos.left,
                          transform: "translateY(-100%)",
                          width: "min(212px, calc(100vw - 2rem))",
                        }}
                      >
                        <div className="mb-1.5 px-1.5 pt-0.5 text-[11px] font-medium text-stone-400">生成数量</div>
                        <div className="grid grid-cols-4 gap-1.5">
                          {COUNT_OPTIONS.map((value) => {
                            const active = value === parsedCount;
                            return (
                              <button
                                key={value}
                                type="button"
                                className={cn(
                                  "flex h-9 cursor-pointer items-center justify-center rounded-lg font-data text-[13px] tabular-nums transition",
                                  active
                                    ? "bg-stone-900 font-semibold text-white"
                                    : "bg-stone-50 text-stone-700 hover:bg-stone-100",
                                )}
                                onClick={() => {
                                  onImageCountChange(String(value));
                                  setIsCountMenuOpen(false);
                                }}
                              >
                                {value}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="relative shrink-0">
                    <button
                      ref={sizeMenuBtnRef}
                      type="button"
                      className={cn(
                        "inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px] font-medium transition sm:h-10 sm:gap-2 sm:px-4 sm:text-[13px]",
                        isSizeMenuOpen
                          ? "bg-stone-900 text-white"
                          : "bg-stone-100 text-stone-700 hover:bg-stone-200",
                      )}
                      onClick={() => {
                        if (!isSizeMenuOpen && sizeMenuBtnRef.current) {
                          const rect = sizeMenuBtnRef.current.getBoundingClientRect();
                          const menuWidth = Math.min(232, window.innerWidth - 32);
                          setSizeMenuPos({
                            top: rect.top - 8,
                            left: Math.max(16, Math.min(rect.left, window.innerWidth - menuWidth - 16)),
                          });
                        }
                        setIsSizeMenuOpen((open) => !open);
                      }}
                    >
                      <span className={cn("hidden sm:inline", isSizeMenuOpen ? "text-white/70" : "text-stone-500")}>比例</span>
                      {selectedSize.value ? (
                        <span
                          className={cn(
                            "inline-block shrink-0 rounded-[3px] border",
                            isSizeMenuOpen ? "border-white/60 bg-white/20" : "border-stone-400 bg-stone-200",
                          )}
                          style={{
                            width: `${selectedSize.w * 0.45}px`,
                            height: `${selectedSize.h * 0.45}px`,
                          }}
                          aria-hidden
                        />
                      ) : null}
                      <span className="font-data tabular-nums">{selectedSize.value || "未指定"}</span>
                      <ChevronDown
                        className={cn(
                          "size-3.5 shrink-0 opacity-60 transition",
                          isSizeMenuOpen && "rotate-180",
                        )}
                      />
                    </button>
                    {isSizeMenuOpen ? (
                      <div
                        ref={sizeMenuRef}
                        className="fixed z-[80] max-h-[55dvh] overflow-y-auto rounded-2xl border border-stone-200/70 bg-white p-1.5 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_24px_48px_-16px_rgba(15,23,42,0.18)]"
                        style={{
                          top: sizeMenuPos.top,
                          left: sizeMenuPos.left,
                          transform: "translateY(-100%)",
                          width: "min(232px, calc(100vw - 2rem))",
                        }}
                      >
                        <div className="mb-1 px-2 pt-1 text-[11px] font-medium text-stone-400">画面比例</div>
                        {SIZE_OPTIONS.map((option) => {
                          const active = option.value === imageSize;
                          return (
                            <button
                              key={option.label}
                              type="button"
                              className={cn(
                                "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition",
                                active ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100",
                              )}
                              onClick={() => {
                                onImageSizeChange(option.value);
                                setIsSizeMenuOpen(false);
                              }}
                            >
                              <span
                                className={cn(
                                  "flex size-8 shrink-0 items-center justify-center rounded-md",
                                  active ? "bg-white/10" : "bg-stone-100",
                                )}
                              >
                                {option.value ? (
                                  <span
                                    className={cn(
                                      "block rounded-[2px] border",
                                      active ? "border-white/80" : "border-stone-400",
                                    )}
                                    style={{
                                      width: `${option.w * 0.7}px`,
                                      height: `${option.h * 0.7}px`,
                                    }}
                                  />
                                ) : (
                                  <span
                                    className={cn(
                                      "block size-4 rounded-[2px] border border-dashed",
                                      active ? "border-white/70" : "border-stone-400",
                                    )}
                                  />
                                )}
                              </span>
                              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                <span className="font-data text-[13px] font-semibold tabular-nums">{option.label}</span>
                                <span
                                  className={cn(
                                    "truncate text-[11px]",
                                    active ? "text-white/70" : "text-stone-400",
                                  )}
                                >
                                  {option.desc}
                                </span>
                              </span>
                              {active ? <Check className="size-3.5 shrink-0" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                </div>

                <button
                  type="button"
                  onClick={() => void onSubmit()}
                  disabled={!prompt.trim()}
                  className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-stone-900 text-white shadow-[0_1px_2px_rgba(15,23,42,0.1),0_4px_12px_-2px_rgba(15,23,42,0.2)] transition hover:bg-stone-800 hover:shadow-[0_1px_2px_rgba(15,23,42,0.1),0_8px_20px_-4px_rgba(15,23,42,0.3)] disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400 disabled:shadow-none sm:size-10"
                  aria-label={referenceImages.length > 0 ? "编辑图片" : "生成图片"}
                >
                  <ArrowUp className="size-3.5 sm:size-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

