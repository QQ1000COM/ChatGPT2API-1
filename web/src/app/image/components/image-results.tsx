"use client";

import { useState } from "react";
import {
  AlertCircle,
  Check,
  Clock3,
  Crosshair,
  Download,
  Info,
  LoaderCircle,
  Reply,
  RotateCcw,
  Share2,
  Sparkles,
  Trash2,
  WalletCards,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

/**
 * 单张图片在画廊里的发布态。
 *  - idle：未发布（默认）
 *  - publishing：正在发请求
 *  - published：已发布
 *  - unsupported：本地 b64 图，没有 image_rel，无法发画廊（按钮置灰）
 */
export type ImagePublishState = "idle" | "publishing" | "published" | "unsupported";

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  onReplyToTurn?: (conversationId: string, turnId: string, aiMessage: string) => void;
  onRegionEditReference?: (conversationId: string, referenceImage: StoredReferenceImage, instruction: string) => void;
  /**
   * 单图发布到画廊。turnId + image 一起传，让父组件能拿到 turn.prompt / model / size
   * 拼成 publish 请求体。父组件用 publishState 反推每张图的状态显示。
   */
  onPublishImage?: (conversationId: string, turnId: string, image: StoredImage) => void | Promise<void>;
  /** 用 image.id 索引发布态。父组件用 Map 维护。 */
  publishStateOf?: (image: StoredImage) => ImagePublishState;
  formatConversationTime: (value: string) => string;
};

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  const url = image.url || "";
  const imagePathIndex = url.indexOf("/images/");
  return imagePathIndex >= 0 ? url.slice(imagePathIndex) : url;
}

type RegionSelection = { x: number; y: number; width: number; height: number };
type RegionEditState = { conversationId: string; image: StoredImage; src: string } | null;

function normalizeRegionSelection(selection: RegionSelection): RegionSelection | null {
  const x = Math.min(selection.x, selection.x + selection.width);
  const y = Math.min(selection.y, selection.y + selection.height);
  const width = Math.abs(selection.width);
  const height = Math.abs(selection.height);
  if (width < 0.02 || height < 0.02) {
    return null;
  }
  return { x, y, width, height };
}

function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

async function buildRegionReference(src: string, selection: RegionSelection) {
  const image = await loadImageElement(src);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("浏览器不支持画布");
  }
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const x = selection.x * canvas.width;
  const y = selection.y * canvas.height;
  const width = selection.width * canvas.width;
  const height = selection.height * canvas.height;
  ctx.save();
  ctx.fillStyle = "rgba(244, 63, 94, 0.12)";
  ctx.strokeStyle = "rgba(244, 63, 94, 0.95)";
  ctx.lineWidth = Math.max(6, Math.round(Math.min(canvas.width, canvas.height) * 0.01));
  ctx.setLineDash([ctx.lineWidth * 2, ctx.lineWidth]);
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
  return canvas.toDataURL("image/png");
}

// 单独识别"额度不足"这一类错误。这种错误不应该让用户去点"重试"或者"回复"——
// 重试还是会被后端打回来，而模型也并没有真正反问什么，没东西可回复。
// 所以走一张专门的卡片，只展示提示信息，引导用户联系管理员。
function isQuotaError(message: string | undefined | null) {
  if (!message) return false;
  return message.includes("额度不足");
}

function getUserFacingImageError(message: string | undefined | null) {
  const detail = String(message || "").trim();
  if (!detail) {
    return "生成失败，请联系管理员检查账号、额度或上游服务状态。";
  }
  if (detail.includes("额度不足")) {
    return `${detail}，请联系管理员追加额度后再试。`;
  }
  if (detail.startsWith("生成失败")) {
    return detail.includes("管理员") ? detail : `${detail}，请联系管理员解决。`;
  }
  return `生成失败：${detail}。请联系管理员检查账号、额度或上游服务状态。`;
}

async function downloadStoredImage(image: StoredImage, index: number) {
  let blob: Blob;
  if (image.b64_json) {
    const binary = atob(image.b64_json);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    blob = new Blob([bytes], { type: "image/png" });
  } else if (image.url) {
    const res = await fetch(image.url);
    blob = await res.blob();
  } else {
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `image-${index + 1}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 错误卡片里的"模型反问/拒绝"原文直接全部展示，
// 让卡片随内容长度自适应高度，避免悬浮提示带来的闪烁/对位问题。
// 用 react-markdown 渲染，覆盖原生标签样式以贴合卡片小字体的语境，
// 列表/代码/链接都做了紧凑处理避免撑破布局。
function ErrorMessageBlock({ message }: { message: string }) {
  return (
    <div
      className={cn(
        "text-[12px] leading-5 break-words text-stone-600 sm:text-[13px] sm:leading-6",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-1 whitespace-pre-wrap">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-stone-800">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-stone-700 underline decoration-stone-300 underline-offset-2 transition hover:text-stone-900 hover:decoration-stone-500"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
          li: ({ children }) => <li className="leading-5 sm:leading-6">{children}</li>,
          h1: ({ children }) => <h1 className="my-1 text-[13px] font-semibold text-stone-800 sm:text-sm">{children}</h1>,
          h2: ({ children }) => <h2 className="my-1 text-[13px] font-semibold text-stone-800 sm:text-sm">{children}</h2>,
          h3: ({ children }) => <h3 className="my-1 text-[12px] font-semibold text-stone-800 sm:text-[13px]">{children}</h3>,
          h4: ({ children }) => <h4 className="my-1 text-[12px] font-semibold text-stone-800 sm:text-[13px]">{children}</h4>,
          h5: ({ children }) => <h5 className="my-1 text-[12px] font-semibold text-stone-800 sm:text-[13px]">{children}</h5>,
          h6: ({ children }) => <h6 className="my-1 text-[12px] font-semibold text-stone-800 sm:text-[13px]">{children}</h6>,
          blockquote: ({ children }) => (
            <blockquote className="my-1 border-l-2 border-stone-200 pl-2 text-stone-500">{children}</blockquote>
          ),
          hr: () => <hr className="my-2 border-stone-200" />,
          code: ({ className, children, ...props }) => {
            const isInline = !/language-/.test(className || "");
            if (isInline) {
              return (
                <code
                  className="rounded bg-stone-100 px-1 py-0.5 text-[11px] font-mono text-stone-800 sm:text-[12px]"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={cn("font-mono text-[11px] sm:text-[12px]", className)} {...props}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="my-1 overflow-x-auto rounded-lg bg-stone-100 px-2 py-1.5 text-[11px] leading-5 text-stone-800 sm:text-[12px]">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-1 overflow-x-auto">
              <table className="w-full border-collapse text-[11px] sm:text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-stone-200 bg-stone-50 px-2 py-1 text-left font-medium text-stone-700">{children}</th>
          ),
          td: ({ children }) => <td className="border border-stone-200 px-2 py-1">{children}</td>,
        }}
      >
        {message}
      </ReactMarkdown>
    </div>
  );
}

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  onReplyToTurn,
  onRegionEditReference,
  onPublishImage,
  publishStateOf,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});
  const [expandedPrompts, setExpandedPrompts] = useState<Record<string, boolean>>({});
  const [regionEdit, setRegionEdit] = useState<RegionEditState>(null);
  const [regionSelection, setRegionSelection] = useState<RegionSelection | null>(null);
  const [regionDragStart, setRegionDragStart] = useState<{ x: number; y: number } | null>(null);

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  const startRegionEdit = (conversationId: string, image: StoredImage, src: string) => {
    setRegionEdit({ conversationId, image, src });
    setRegionSelection(null);
    setRegionDragStart(null);
  };

  const confirmRegionEdit = async () => {
    const normalized = regionSelection ? normalizeRegionSelection(regionSelection) : null;
    if (!regionEdit || !normalized || !onRegionEditReference) {
      return;
    }
    const instruction =
      "局部重绘：只修改红色框选区域，保持框外产品主体、构图、颜色、比例和背景不变；修改后自然融合，不要改变未圈选区域。";
    try {
      const dataUrl = await buildRegionReference(regionEdit.src, normalized);
      onRegionEditReference(
        regionEdit.conversationId,
        {
          name: `region-edit-${regionEdit.image.id}.png`,
          type: "image/png",
          dataUrl,
        },
        instruction,
      );
    } catch {
      onRegionEditReference(
        regionEdit.conversationId,
        {
          name: `region-edit-${regionEdit.image.id}.png`,
          type: "image/png",
          dataUrl: regionEdit.src,
        },
        instruction,
      );
    } finally {
      setRegionEdit(null);
      setRegionSelection(null);
      setRegionDragStart(null);
    }
  };

  if (!selectedConversation) {
    return (
      <div className="relative flex h-full items-center justify-center text-center">
        {/* 装饰层用 fixed inset-0 + overflow-hidden 包一层，
            把超出视口的光斑裁剪掉，避免撑出滚动条；
            内层光斑改回 absolute，相对这个视口尺寸的容器定位。
            z-0 让它在内容下方、navbar (z-40) 后方，导航栏 backdrop-blur 自然柔化透出。 */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
          style={{
            // 椭圆羽化：中心 18% 内全保留，往外一路平滑过渡到完全透明，
            // 边缘没有任何"光层"的轮廓感。
            maskImage:
              "radial-gradient(ellipse 60% 70% at 50% 50%, #000 18%, rgba(0,0,0,0.6) 55%, transparent 95%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 60% 70% at 50% 50%, #000 18%, rgba(0,0,0,0.6) 55%, transparent 95%)",
          }}
        >
          {/* Aurora 光斑：冷蓝 + 暖米，错位漂浮，softer + 更大半径，避免硬边 */}
          <div
            className="aurora-drift-a absolute top-[-10%] left-[-8%] size-[720px] blur-[130px]"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, oklch(0.74 0.11 250 / 0.40), transparent 70%)",
            }}
          />
          <div
            className="aurora-drift-b absolute right-[-8%] bottom-[-8%] size-[720px] blur-[130px]"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, oklch(0.80 0.09 60 / 0.36), transparent 70%)",
            }}
          />
          {/* 反角 accent，铺一层薄色，避免出现"对角空缺" */}
          <div
            className="aurora-drift-b absolute top-[-6%] right-[8%] size-[520px] blur-[120px]"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, oklch(0.82 0.07 60 / 0.24), transparent 70%)",
            }}
          />
          <div
            className="aurora-drift-a absolute bottom-[-6%] left-[10%] size-[520px] blur-[120px]"
            style={{
              background:
                "radial-gradient(circle at 50% 50%, oklch(0.76 0.09 250 / 0.26), transparent 70%)",
            }}
          />

          {/* 中心慢转 conic 极淡光晕，给画面"呼吸"但不形成边界 */}
          <div
            className="aurora-spin absolute top-1/2 left-1/2 size-[960px] -translate-x-1/2 -translate-y-1/2 opacity-50 blur-2xl"
            style={{
              background:
                "conic-gradient(from 90deg at 50% 50%, transparent 0deg, oklch(0.85 0.06 250 / 0.18) 70deg, transparent 150deg, oklch(0.86 0.06 60 / 0.16) 250deg, transparent 330deg)",
            }}
          />
        </div>

        {/* 文案内容 */}
        <div className="relative w-full max-w-4xl px-6">
          {/* 标题上方 eyebrow */}
          <div className="mb-5 flex items-center justify-center gap-3 sm:mb-6">
            <span className="h-px w-10 bg-stone-300" />
            <span className="font-data text-[10px] font-semibold tracking-[0.32em] text-stone-500 uppercase">
              Generative · Atelier
            </span>
            <span className="h-px w-10 bg-stone-300" />
          </div>

          <h1
            className="text-2xl font-semibold tracking-tight text-stone-950 sm:text-3xl md:text-5xl"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            Turn ideas into images
          </h1>
          <p
            className="mx-auto mt-3 max-w-[280px] text-sm italic tracking-[0.01em] text-stone-500 sm:mt-4 sm:max-w-none sm:text-[15px]"
            style={{
              fontFamily: '"Palatino Linotype","Book Antiqua","URW Palladio L","Times New Roman",serif',
            }}
          >
            在同一窗口里保留本地历史与任务状态，并从已有结果图继续发起新的无状态编辑。
          </p>

          {/* 标题下方编号轴 */}
          <div className="mt-7 flex items-center justify-center gap-3 sm:mt-9">
            <span className="font-data text-[10px] font-semibold tracking-[0.28em] text-stone-400 tabular-nums">
              01
            </span>
            <span className="h-px w-12 bg-stone-300/80" />
            <span className="font-data text-[10px] font-semibold tracking-[0.28em] text-stone-400 uppercase">
              Sketch → Render
            </span>
            <span className="h-px w-12 bg-stone-300/80" />
            <span className="font-data text-[10px] font-semibold tracking-[0.28em] text-stone-400 tabular-nums">
              02
            </span>
          </div>
        </div>
      </div>
    );
  }

  // 整段对话里所有「成功生成」的图（按 turn 顺序）。
  // 灯箱的左侧缩略图带就走这份列表，参考图（用户上传）不计入。
  const allSuccessfulImages: ImageLightboxItem[] = selectedConversation.turns.flatMap((turn) =>
    turn.images.flatMap((image) => {
      const src = image.status === "success" ? getStoredImageSrc(image) : "";
      if (!src) return [];
      return [
        {
          id: image.id,
          src,
          sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
          dimensions: imageDimensions[image.id],
        },
      ];
    }),
  );

  return (
    <>
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
        }));
        const isPromptExpanded = expandedPrompts[turn.id] === true;
        const shouldFoldPrompt = turn.prompt.length > 120 || turn.prompt.includes("\n");
        const visiblePrompt =
          shouldFoldPrompt && !isPromptExpanded ? `${turn.prompt.slice(0, 120).trimEnd()}...` : turn.prompt;

        return (
          <div key={turn.id} className="flex flex-col gap-3 sm:gap-4">
            {!turn.promptDeleted ? (
              <div className="flex justify-end">
                <div className="max-w-[90%] px-1 py-1 text-[14px] leading-6 text-stone-900 sm:max-w-[82%] sm:text-[15px] sm:leading-7">
                  <div className="mb-1.5 flex flex-wrap justify-end gap-2 text-[11px] text-stone-400 sm:mb-2">
                    <span>第 {turnIndex + 1} 轮</span>
                    <span>
                      {turn.mode === "edit" ? "编辑图" : "文生图"}
                    </span>
                    <span>{getTurnStatusLabel(turn.status)}</span>
                    <span>{formatConversationTime(turn.createdAt)}</span>
                  </div>
                  <div className="whitespace-pre-wrap text-right">{visiblePrompt}</div>
                  {shouldFoldPrompt ? (
                    <button
                      type="button"
                      onClick={() => setExpandedPrompts((current) => ({ ...current, [turn.id]: !isPromptExpanded }))}
                      className="mt-1 text-[11px] font-medium text-stone-400 transition hover:text-stone-700"
                    >
                      {isPromptExpanded ? "收起提示词" : "展开提示词"}
                    </button>
                  ) : null}
                  <div className="mt-2 flex flex-wrap items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => void onReuseTurnConfig(selectedConversation.id, turn.id)}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-stone-100 px-2.5 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                    >
                      复用配置
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePrompt(selectedConversation.id, turn.id)}
                      className="inline-flex size-7 items-center justify-center rounded-full text-stone-300 transition hover:bg-stone-100 hover:text-stone-700"
                      aria-label="删除提示词记录"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {!turn.resultsDeleted ? (
              <div className="flex justify-start">
                <div className="w-full p-1">
                  {turn.referenceImages.length > 0 ? (
                    <div className="mb-4 flex flex-col items-start">
                      <div className="mb-2 text-[11px] font-medium text-stone-400 sm:text-xs">本轮参考图</div>
                      <div className="flex flex-wrap gap-2 sm:gap-3">
                        {turn.referenceImages.map((image, index) => (
                          <div key={`${turn.id}-${image.name}-${index}`} className="flex flex-col items-start gap-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenLightbox(referenceLightboxImages, index)}
                              className="group relative size-20 overflow-hidden rounded-2xl border border-stone-200/80 bg-stone-50 transition hover:border-stone-300 sm:size-24"
                              aria-label={`预览参考图 ${image.name || index + 1}`}
                            >
                              <img
                                src={image.dataUrl}
                                alt={image.name || `参考图 ${index + 1}`}
                                className="absolute inset-0 h-full w-full object-cover transition duration-200 group-hover:scale-[1.02]"
                              />
                            </button>
                            <button
                              type="button"
                              onClick={() => onContinueEdit(selectedConversation.id, image)}
                              className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                            >
                              <Sparkles className="size-3" />
                              加入编辑
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px] text-stone-500 sm:mb-4 sm:gap-2 sm:text-xs">
                    <span className="rounded-full bg-stone-100 px-3 py-1">{turn.count} 张</span>
                    <span className="rounded-full bg-stone-100 px-3 py-1">{getTurnStatusLabel(turn.status)}</span>
                    {turn.status === "queued" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-3 py-1 text-stone-500">
                        <Clock3 className="size-3 text-stone-400" />
                        排队中：等待前面的任务完成
                      </span>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:gap-3">
                    {turn.images.map((image, index) => {
                      const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                      if (image.status === "success" && imageSrc) {
                        const currentIndex = allSuccessfulImages.findIndex((item) => item.id === image.id);
                        const sizeLabel = image.b64_json ? formatBase64ImageSize(image.b64_json) : "";
                        const dimensions = imageDimensions[image.id];
                        const imageMeta = [sizeLabel, dimensions].filter(Boolean).join(" · ");

                        return (
                          <div
                            key={image.id}
                            className="break-inside-avoid"
                          >
                            <button
                              type="button"
                              onClick={() => onOpenLightbox(allSuccessfulImages, currentIndex)}
                              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-2xl"
                            >
                              <img
                                src={imageSrc}
                                alt={`Generated result ${index + 1}`}
                                className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90"
                                onLoad={(event) => {
                                  updateImageDimensions(
                                    image.id,
                                    event.currentTarget.naturalWidth,
                                    event.currentTarget.naturalHeight,
                                  );
                                }}
                              />
                            </button>
                            {/* 单格底部：左侧"结果 N + 尺寸"自适应截断，右侧 3 个按钮恒为图标。
                                3 列 grid 下每格 ≈ 视口 1/3，再叠中文 label 任何断点都挤不下，
                                曾出现"加入编辑"逐字竖排 bug。统一图标 + tooltip，按钮 shrink-0 + nowrap 兜底。 */}
                            <div className="flex items-center gap-2 px-0.5 py-1.5 text-[10px] sm:px-1 sm:py-2 sm:text-xs">
                              <div className="min-w-0 flex-1 truncate whitespace-nowrap text-stone-400">
                                <span>结果 {index + 1}</span>
                                {imageMeta ? <span className="ml-2">{imageMeta}</span> : null}
                              </div>
                              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                                <button
                                  type="button"
                                  onClick={() => onContinueEdit(selectedConversation.id, image)}
                                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                                  aria-label="加入编辑"
                                  title="加入编辑"
                                >
                                  <Sparkles className="size-3.5" />
                                </button>
                                {onRegionEditReference ? (
                                  <button
                                    type="button"
                                    onClick={() => startRegionEdit(selectedConversation.id, image, imageSrc)}
                                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                                    aria-label="局部重绘"
                                    title="局部重绘"
                                  >
                                    <Crosshair className="size-3.5" />
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void downloadStoredImage(image, index)}
                                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                                  aria-label="下载"
                                  title="下载"
                                >
                                  <Download className="size-3.5" />
                                </button>
                                {/* 发布到画廊。state 控制视觉与是否可点：
                                    - idle：可点击，默认描边按钮
                                    - publishing：禁用 + 旋转图标
                                    - published：禁用 + 对勾，title 提示"已发布"
                                    - unsupported：禁用 + 灰显，title 提示原因（一般是 b64 直返不带 url） */}
                                {(() => {
                                  const state = publishStateOf?.(image) ?? "idle";
                                  const disabled = state !== "idle";
                                  const Icon =
                                    state === "publishing"
                                      ? LoaderCircle
                                      : state === "published"
                                        ? Check
                                        : Share2;
                                  const label =
                                    state === "publishing"
                                      ? "发布中"
                                      : state === "published"
                                        ? "已发布"
                                        : "发布画廊";
                                  return (
                                    <button
                                      type="button"
                                      onClick={() =>
                                        onPublishImage?.(selectedConversation.id, turn.id, image)
                                      }
                                      disabled={disabled}
                                      title={
                                        state === "unsupported"
                                          ? "本地图片暂无法发布到画廊"
                                          : state === "published"
                                            ? "已发布到画廊"
                                            : "发布到画廊"
                                      }
                                      className={cn(
                                        "inline-flex size-7 shrink-0 items-center justify-center rounded-full transition",
                                        state === "published"
                                          ? "bg-emerald-50 text-emerald-700"
                                          : state === "unsupported"
                                            ? "cursor-not-allowed bg-stone-50 text-stone-300"
                                            : "bg-stone-100 text-stone-600 hover:bg-stone-200 hover:text-stone-900",
                                        disabled && state !== "published" && "opacity-70",
                                      )}
                                      aria-label={label}
                                    >
                                      <Icon
                                        className={cn(
                                          "size-3.5",
                                          state === "publishing" && "animate-spin",
                                        )}
                                      />
                                    </button>
                                  );
                                })()}
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (image.status === "error") {
                        const rawErrorMessage = image.error || "";
                        const errorMessage = getUserFacingImageError(rawErrorMessage);
                        // 额度不足是"配额"问题不是"模型反问"，重试/回复都没有意义，
                        // 单独走一张安静的提示卡，引导用户联系管理员。
                        if (isQuotaError(rawErrorMessage)) {
                          return (
                            <div
                              key={image.id}
                              className="relative break-inside-avoid rounded-xl border border-amber-200/70 bg-amber-50/60"
                            >
                              <button
                                type="button"
                                onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                                className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded-full text-amber-500/70 transition hover:bg-white hover:text-rose-500"
                                aria-label="删除生成结果"
                              >
                                <Trash2 className="size-3" />
                              </button>
                              <div className="flex flex-col items-center gap-2 px-3 py-4 text-center sm:gap-3 sm:px-5 sm:py-5">
                                <span className="inline-flex size-7 items-center justify-center rounded-full bg-white text-amber-500 shadow-sm sm:size-8">
                                  <WalletCards className="size-3.5 sm:size-4" />
                                </span>
                                <p className="text-[12px] leading-5 font-medium text-amber-900 sm:text-[13px] sm:leading-6">
                                  {errorMessage}
                                </p>
                                <p className="text-[11px] leading-4 text-amber-700/80 sm:text-[12px] sm:leading-5">
                                  请联系管理员追加额度后再继续生成
                                </p>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <div
                            key={image.id}
                            className="break-inside-avoid rounded-xl border border-stone-200/80 bg-stone-50"
                          >
                            <div className="flex flex-col gap-2 px-3 py-4 sm:gap-3 sm:px-5 sm:py-5">
                              <div className="flex justify-center">
                                <span className="inline-flex size-7 items-center justify-center rounded-full bg-white text-stone-400 shadow-sm sm:size-8">
                                  <AlertCircle className="size-3.5 sm:size-4" />
                                </span>
                              </div>
                              <ErrorMessageBlock message={errorMessage} />
                              <div className="flex flex-wrap items-center justify-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                  className="inline-flex items-center gap-1 rounded-full bg-stone-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-stone-800 sm:px-3 sm:text-xs"
                                >
                                  <RotateCcw className="size-3" />
                                  重试
                                </button>
                                {onReplyToTurn && rawErrorMessage ? (
                                  <div className="relative inline-flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => onReplyToTurn(selectedConversation.id, turn.id, rawErrorMessage)}
                                      className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-stone-700 ring-1 ring-stone-200 transition hover:bg-stone-100 hover:text-stone-900 sm:px-3 sm:text-xs"
                                      aria-label="基于该提问继续回复"
                                    >
                                      <Reply className="size-3" />
                                      回复
                                    </button>
                                    {/* Info 提示：纯 CSS peer-hover 实现，
                                        鼠标悬浮 / 键盘聚焦 ! 图标时显示，离开即隐。
                                        tooltip 是 pointer-events-none，不会反过来拦截鼠标，
                                        所以不会出现之前那种"在触发区和卡片之间穿模"的闪烁。 */}
                                    <span
                                      tabIndex={0}
                                      role="button"
                                      aria-label="为什么需要点回复"
                                      className="peer inline-flex size-5 cursor-help items-center justify-center rounded-full text-stone-400 ring-1 ring-stone-200 transition hover:bg-white hover:text-stone-700 focus:bg-white focus:text-stone-700 focus:outline-none"
                                    >
                                      <Info className="size-3" />
                                    </span>
                                    <div
                                      role="tooltip"
                                      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-60 -translate-x-1/2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-left text-[11px] leading-5 text-stone-600 opacity-0 shadow-[0_2px_4px_rgba(15,23,42,0.04),0_12px_28px_-12px_rgba(15,23,42,0.25)] transition peer-hover:opacity-100 peer-focus:opacity-100 sm:text-[12px]"
                                    >
                                      <p className="mb-1 font-medium text-stone-800">为什么要点"回复"？</p>
                                      <p>
                                        图片接口本身没有上下文。点"回复"会把这一轮的提问与参考图一起带给模型；
                                        如果直接在下方输入框回答，模型只会当成一次新的画图请求，不知道你在回应它的反问。
                                      </p>
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={image.id}
                          className="relative aspect-square break-inside-avoid overflow-hidden rounded-2xl bg-stone-100/80"
                        >
                          {turn.status === "queued" ? (
                            <div className="flex h-full flex-col items-center justify-center gap-2 px-2 py-3 text-center text-stone-400">
                              <span className="inline-flex size-7 items-center justify-center rounded-full bg-white text-stone-400 shadow-sm sm:size-8">
                                <Clock3 className="size-3.5 sm:size-4" />
                              </span>
                              <p className="text-[11px] leading-4 text-stone-500 sm:text-[13px]">排队中，等待提交</p>
                            </div>
                          ) : (
                            <>
                              <div aria-hidden className="dot-grid-loader absolute inset-0" />
                              <div className="absolute top-2 left-3 text-[11px] font-medium text-stone-500 sm:top-3 sm:left-4 sm:text-xs">
                                生成中，完成后自动保存
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {turn.status === "error" && turn.error && !isQuotaError(turn.error) ? (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-[11px] text-stone-500 sm:mt-4 sm:text-xs">
                      <AlertCircle className="size-3 text-stone-400" />
                      <span>{getUserFacingImageError(turn.error)}</span>
                    </div>
                  ) : null}

                  {isQuotaError(turn.error) ? null : (
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] sm:mt-4">
                      <button
                        type="button"
                        onClick={() => void onRegenerateTurn(selectedConversation.id, turn.id)}
                        className="inline-flex items-center gap-1 rounded-full bg-stone-100 px-2.5 py-1 font-medium text-stone-500 transition hover:bg-stone-200 hover:text-stone-900"
                      >
                        <RotateCcw className="size-3" />
                        全部重新生成
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteResults(selectedConversation.id, turn.id)}
                        className="inline-flex size-6 items-center justify-center rounded-full text-stone-300 transition hover:bg-rose-50 hover:text-rose-500"
                        aria-label="删除生成结果"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
    {regionEdit ? (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-stone-950/55 px-3 py-4 backdrop-blur-sm">
        <div className="flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-stone-900">局部重绘圈选</div>
              <div className="mt-0.5 text-xs text-stone-500">拖动框选要修改的区域，框外会要求模型保持不变。</div>
            </div>
            <button
              type="button"
              onClick={() => {
                setRegionEdit(null);
                setRegionSelection(null);
                setRegionDragStart(null);
              }}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
            >
              取消
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-stone-100 p-3 sm:p-5">
            <div
              className="relative mx-auto w-fit max-w-full touch-none overflow-hidden rounded-xl bg-white shadow-sm"
              onPointerDown={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
                setRegionDragStart({ x, y });
                setRegionSelection({ x, y, width: 0, height: 0 });
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!regionDragStart) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
                const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
                setRegionSelection({
                  x: regionDragStart.x,
                  y: regionDragStart.y,
                  width: x - regionDragStart.x,
                  height: y - regionDragStart.y,
                });
              }}
              onPointerUp={() => setRegionDragStart(null)}
              onPointerCancel={() => setRegionDragStart(null)}
            >
              <img src={regionEdit.src} alt="局部重绘参考图" className="block max-h-[70dvh] max-w-full select-none object-contain" draggable={false} />
              {regionSelection ? (() => {
                const normalized = normalizeRegionSelection(regionSelection);
                if (!normalized) return null;
                return (
                  <div
                    className="pointer-events-none absolute border-2 border-rose-500 bg-rose-500/10 shadow-[0_0_0_9999px_rgba(15,23,42,0.18)]"
                    style={{
                      left: `${normalized.x * 100}%`,
                      top: `${normalized.y * 100}%`,
                      width: `${normalized.width * 100}%`,
                      height: `${normalized.height * 100}%`,
                    }}
                  />
                );
              })() : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-100 px-4 py-3">
            <div className="text-xs text-stone-500">确认后会把带红框的图片加入编辑，并自动补上“只改圈选区域”的提示词。</div>
            <button
              type="button"
              onClick={() => void confirmRegionEdit()}
              disabled={!normalizeRegionSelection(regionSelection || { x: 0, y: 0, width: 0, height: 0 })}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-stone-900 px-4 text-sm font-semibold text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-400"
            >
              <Crosshair className="size-4" />
              加入局部重绘
            </button>
          </div>
        </div>
      </div>
    ) : null}
    </>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "生成中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "生成失败";
}

function formatBase64ImageSize(base64: string) {
  const normalized = base64.replace(/\s/g, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const bytes = Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);

  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function formatImageDimensions(width: number, height: number) {
  return `${width} x ${height}`;
}
