"use client";

import { useState } from "react";
import { AlertCircle, Clock3, Download, LoaderCircle, RotateCcw, Sparkles, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ImageConversation, ImageTurnStatus, StoredImage, StoredReferenceImage } from "@/store/image-conversations";

export type ImageLightboxItem = {
  id: string;
  src: string;
  sizeLabel?: string;
  dimensions?: string;
};

type ImageResultsProps = {
  selectedConversation: ImageConversation | null;
  onOpenLightbox: (images: ImageLightboxItem[], index: number) => void;
  onContinueEdit: (conversationId: string, image: StoredImage | StoredReferenceImage) => void;
  onDeletePrompt: (conversationId: string, turnId: string) => void;
  onDeleteResults: (conversationId: string, turnId: string) => void;
  onReuseTurnConfig: (conversationId: string, turnId: string) => void | Promise<void>;
  onRegenerateTurn: (conversationId: string, turnId: string) => void | Promise<void>;
  onRetryImage: (conversationId: string, turnId: string, imageId: string) => void | Promise<void>;
  formatConversationTime: (value: string) => string;
};

function getStoredImageSrc(image: StoredImage) {
  if (image.b64_json) {
    return `data:image/png;base64,${image.b64_json}`;
  }
  return image.url || "";
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

export function ImageResults({
  selectedConversation,
  onOpenLightbox,
  onContinueEdit,
  onDeletePrompt,
  onDeleteResults,
  onReuseTurnConfig,
  onRegenerateTurn,
  onRetryImage,
  formatConversationTime,
}: ImageResultsProps) {
  const [imageDimensions, setImageDimensions] = useState<Record<string, string>>({});

  const updateImageDimensions = (id: string, width: number, height: number) => {
    const dimensions = formatImageDimensions(width, height);
    setImageDimensions((current) => {
      if (current[id] === dimensions) {
        return current;
      }
      return { ...current, [id]: dimensions };
    });
  };

  if (!selectedConversation) {
    return (
      <div className="relative flex h-full items-center justify-center text-center">
        {/* 装饰层全部 absolute，不开 overflow-hidden，让光自然外溢与背景融合 */}

        {/* Aurora 光斑：冷蓝 + 暖米，错位漂浮，softer + 更大半径，避免硬边 */}
        <div
          aria-hidden
          className="aurora-drift-a pointer-events-none absolute top-[6%] left-[10%] size-[520px] blur-[110px]"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, oklch(0.74 0.11 250 / 0.32), transparent 70%)",
          }}
        />
        <div
          aria-hidden
          className="aurora-drift-b pointer-events-none absolute right-[8%] bottom-[6%] size-[520px] blur-[110px]"
          style={{
            background:
              "radial-gradient(circle at 50% 50%, oklch(0.80 0.09 60 / 0.30), transparent 70%)",
          }}
        />

        {/* 中心慢转 conic 极淡光晕，给画面"呼吸"但不形成边界 */}
        <div
          aria-hidden
          className="aurora-spin pointer-events-none absolute top-1/2 left-1/2 size-[760px] opacity-50 blur-2xl"
          style={{
            background:
              "conic-gradient(from 90deg at 50% 50%, transparent 0deg, oklch(0.85 0.06 250 / 0.18) 70deg, transparent 150deg, oklch(0.86 0.06 60 / 0.16) 250deg, transparent 330deg)",
          }}
        />

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

  return (
    <div className="mx-auto flex w-full max-w-[980px] flex-col gap-5 sm:gap-8">
      {selectedConversation.turns.map((turn, turnIndex) => {
        const referenceLightboxImages = turn.referenceImages.map((image, index) => ({
          id: `${turn.id}-reference-${index}`,
          src: image.dataUrl,
        }));
        const successfulTurnImages = turn.images.flatMap((image) => {
          const src = image.status === "success" ? getStoredImageSrc(image) : "";
          return src
            ? [
                {
                  id: image.id,
                  src,
                  sizeLabel: image.b64_json ? formatBase64ImageSize(image.b64_json) : undefined,
                  dimensions: imageDimensions[image.id],
                },
              ]
            : [];
        });

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
                  <div className="text-right">{turn.prompt}</div>
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
                        等待前序任务完成
                      </span>
                    ) : null}
                  </div>

                  <div className="grid grid-cols-3 gap-2 sm:block sm:columns-2 sm:gap-4 sm:space-y-4 xl:columns-3">
                    {turn.images.map((image, index) => {
                      const imageSrc = image.status === "success" ? getStoredImageSrc(image) : "";
                      if (image.status === "success" && imageSrc) {
                        const currentIndex = successfulTurnImages.findIndex((item) => item.id === image.id);
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
                              onClick={() => onOpenLightbox(successfulTurnImages, currentIndex)}
                              className="group block aspect-square w-full cursor-zoom-in overflow-hidden rounded-2xl bg-stone-50 sm:aspect-auto"
                            >
                              <img
                                src={imageSrc}
                                alt={`Generated result ${index + 1}`}
                                className="block h-full w-full object-cover transition duration-200 group-hover:brightness-90 sm:h-auto sm:object-contain"
                                onLoad={(event) => {
                                  updateImageDimensions(
                                    image.id,
                                    event.currentTarget.naturalWidth,
                                    event.currentTarget.naturalHeight,
                                  );
                                }}
                              />
                            </button>
                            <div className="flex flex-col gap-1 px-0.5 py-1.5 text-[10px] sm:flex-row sm:items-center sm:justify-between sm:gap-2 sm:px-1 sm:py-2 sm:text-xs">
                              <div className="min-w-0 text-stone-400">
                                <span>结果 {index + 1}</span>
                                {imageMeta ? <span className="block sm:ml-2 sm:inline">{imageMeta}</span> : null}
                              </div>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => onContinueEdit(selectedConversation.id, image)}
                                  className="inline-flex h-7 items-center justify-center gap-1 rounded-full bg-stone-100 px-2.5 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                                  aria-label="加入编辑"
                                >
                                  <Sparkles className="size-3" />
                                  <span className="hidden sm:inline">加入编辑</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void downloadStoredImage(image, index)}
                                  className="inline-flex h-7 items-center justify-center gap-1 rounded-full bg-stone-100 px-2.5 text-[11px] font-medium text-stone-600 transition hover:bg-stone-200 hover:text-stone-900"
                                  aria-label="下载"
                                >
                                  <Download className="size-3" />
                                  <span className="hidden sm:inline">下载</span>
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (image.status === "error") {
                        return (
                          <div
                            key={image.id}
                            className="break-inside-avoid overflow-hidden rounded-xl border border-stone-200/80 bg-stone-50"
                          >
                            <div className="flex flex-col items-center justify-center gap-2 px-3 py-4 text-center sm:gap-3 sm:px-5 sm:py-5">
                              <span className="inline-flex size-7 items-center justify-center rounded-full bg-white text-stone-400 shadow-sm sm:size-8">
                                <AlertCircle className="size-3.5 sm:size-4" />
                              </span>
                              <span className="line-clamp-2 text-[11px] leading-4 text-stone-500 sm:line-clamp-3 sm:text-[13px] sm:leading-5">
                                {image.error || "生成失败"}
                              </span>
                              <button
                                type="button"
                                onClick={() => void onRetryImage(selectedConversation.id, turn.id, image.id)}
                                className="inline-flex items-center gap-1 rounded-full bg-stone-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-stone-800 sm:px-3 sm:text-xs"
                              >
                                <RotateCcw className="size-3" />
                                重试
                              </button>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={image.id}
                          className={cn(
                            "break-inside-avoid overflow-hidden rounded-2xl bg-stone-50",
                            turn.size === "1:1" && "aspect-square",
                            turn.size === "16:9" && "aspect-video",
                            turn.size === "9:16" && "aspect-[9/16]",
                            turn.size === "4:3" && "aspect-[4/3]",
                            turn.size === "3:4" && "aspect-[3/4]",
                            !["1:1", "16:9", "9:16", "4:3", "3:4"].includes(turn.size) && "aspect-square",
                          )}
                        >
                          <div className="flex h-full flex-col items-center justify-center gap-2 px-2 py-3 text-center text-stone-400 sm:gap-3 sm:px-6 sm:py-8">
                            <span className="inline-flex size-7 items-center justify-center rounded-full bg-white text-stone-400 shadow-sm sm:size-8">
                              {turn.status === "queued" ? (
                                <Clock3 className="size-3.5 sm:size-4" />
                              ) : (
                                <LoaderCircle className="size-3.5 animate-spin sm:size-4" />
                              )}
                            </span>
                            <p className="text-[11px] leading-4 text-stone-500 sm:text-[13px]">{turn.status === "queued" ? "排队中" : "处理中"}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {turn.status === "error" && turn.error ? (
                    <div className="mt-3 inline-flex items-center gap-2 rounded-full bg-stone-100 px-3 py-1 text-[11px] text-stone-500 sm:mt-4 sm:text-xs">
                      <AlertCircle className="size-3 text-stone-400" />
                      <span>{turn.error}</span>
                    </div>
                  ) : null}

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
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getTurnStatusLabel(status: ImageTurnStatus) {
  if (status === "queued") {
    return "排队中";
  }
  if (status === "generating") {
    return "处理中";
  }
  if (status === "success") {
    return "已完成";
  }
  return "失败";
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
