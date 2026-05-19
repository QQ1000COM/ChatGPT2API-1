"use client";
import { ArrowUp, Check, ChevronDown, ImagePlus, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type RefObject } from "react";

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

type ImageComposerProps = {
  prompt: string;
  imageCount: string;
  imageSize: string;
  availableQuota: string;
  activeTaskCount: number;
  referenceImages: Array<{ name: string; dataUrl: string }>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onPromptChange: (value: string) => void;
  onImageCountChange: (value: string) => void;
  onImageSizeChange: (value: string) => void;
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
  onPromptChange,
  onImageCountChange,
  onImageSizeChange,
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

  return (
    <div className="shrink-0 flex justify-center px-1 sm:px-0">
      <div style={{ width: "min(980px, 100%)" }}>
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

        {referenceImages.length > 0 ? (
          <div className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 sm:mb-3 sm:flex-wrap sm:overflow-visible sm:pb-0">
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
        ) : null}

        <div className="relative overflow-hidden rounded-[28px] bg-white shadow-[0_2px_4px_rgba(15,23,42,0.04),0_14px_24px_-6px_rgba(15,23,42,0.06),0_36px_56px_-16px_rgba(15,23,42,0.05),0_72px_96px_-32px_rgba(15,23,42,0.05)] sm:rounded-[32px]">
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
            <Textarea
              ref={textareaRef}
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              onPaste={handleTextareaPaste}
              placeholder={
                referenceImages.length > 0
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
                  <span className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-stone-100 px-3 text-[12px] font-medium text-stone-500 sm:h-10 sm:px-3.5 sm:text-[13px]">
                    <span className="hidden sm:inline">剩余</span>
                    <span className="font-data tabular-nums text-stone-900">{availableQuota}</span>
                  </span>
                  {activeTaskCount > 0 && (
                    <span className="flex shrink-0 items-center gap-1 font-data text-[11px] tabular-nums text-amber-600 sm:text-[12px]">
                      <LoaderCircle className="size-3 animate-spin" />
                      {activeTaskCount}<span className="hidden sm:inline"> 处理中</span>
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

