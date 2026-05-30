"use client";

import { ClipboardEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, Code2, Copy, Download, FileText, Image as ImageIcon, LoaderCircle, MessageCircle, Mic, Pencil, Pin, PinOff, Plus, Search, Send, Settings2, Star, StopCircle, Trash2, Upload, Wrench, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import webConfig from "@/constants/common-env";
import { fetchMyIdentity } from "@/lib/api";
import { useAuthGuard } from "@/lib/use-auth-guard";
import { cn } from "@/lib/utils";
import { getStoredAuthKey } from "@/store/auth";

type ChatRole = "user" | "assistant";
type ChatMode = "chat" | "responses" | "codex" | "search";
type ChatView = "chat" | "prompts" | "favorites";

type Attachment = {
  id: string;
  name: string;
  type: string;
  size: number;
  kind: "text" | "image" | "binary";
  content: string;
};

type Message = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  favorite?: boolean;
  attachments?: Attachment[];
  model?: string;
};

type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  category?: string;
  model: string;
  mode: ChatMode;
  messages: Message[];
};

type PromptTemplate = {
  id: string;
  name: string;
  category: string;
  text: string;
};

const STORAGE_KEY = "chatgpt2api:ai_workbench:v3";
const DEFAULT_MODELS = ["auto", "gpt-5.1-codex", "codex-mini-latest", "gpt-5", "gpt-5-mini", "gpt-image-2"];
const DEFAULT_PERMISSIONS = ["chat", "attachments", "web", "code", "image_understanding"];
const PROMPTS: PromptTemplate[] = [
  { id: "copywriting", name: "写文案", category: "运营", text: "请为下面产品写一组可直接投放的电商文案，包含标题、主图短句、详情页段落和行动号召：\n\n" },
  { id: "service", name: "客服回复", category: "客服", text: "请把下面用户问题改写成专业、礼貌、能解决问题的客服回复，语气自然，不推诿：\n\n" },
  { id: "selling", name: "商品卖点", category: "电商", text: "请提炼下面商品的核心卖点，按用户痛点、功能优势、使用场景、主图短句输出：\n\n" },
  { id: "code", name: "代码助手", category: "代码", text: "请作为代码助手分析下面需求，给出实现方案、关键改动点、测试命令和风险：\n\n" },
  { id: "report", name: "运营日报", category: "运营", text: "请把下面数据整理成运营日报，包含核心指标、异常波动、原因判断、明日动作：\n\n" },
  { id: "prompt", name: "优化提示词", category: "提示词", text: "请优化下面提示词，让目标、约束、输入输出格式更清晰稳定：\n\n" },
];

function nowId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(value: number) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function createConversation(): Conversation {
  return {
    id: nowId("chat"),
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: "auto",
    mode: "chat",
    messages: [],
  };
}

function titleFromText(value: string) {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 28) : "新对话";
}

function readConversations() {
  if (typeof window === "undefined") return [createConversation()];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]") as Conversation[];
    return Array.isArray(parsed) && parsed.length ? parsed : [createConversation()];
  } catch {
    return [createConversation()];
  }
}

function writeConversations(items: Conversation[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 100)));
}

function attachmentText(attachments: Attachment[]) {
  return attachments.map((file) => {
    if (file.kind === "image") return `\n\n[图片附件: ${file.name}, ${file.type || "image/*"}, ${formatBytes(file.size)}]`;
    if (file.kind === "text") return `\n\n[文件: ${file.name}, ${file.type || "text/plain"}, ${formatBytes(file.size)}]\n\n\`\`\`\n${file.content.slice(0, 12000)}\n\`\`\``;
    return `\n\n[附件: ${file.name}, ${file.type || "application/octet-stream"}, ${formatBytes(file.size)}]`;
  }).join("");
}

function apiMessages(conversation: Conversation, messages: Message[]) {
  return messages.map((message) => {
    if (message.role === "assistant") return { role: "assistant", content: message.content };
    const parts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    if (message.content.trim()) parts.push({ type: "text", text: message.content });
    for (const file of message.attachments || []) {
      if (file.kind === "image" && file.content) parts.push({ type: "image_url", image_url: { url: file.content } });
    }
    return { role: "user", content: parts.length > 1 ? parts : parts[0]?.type === "text" ? parts[0].text : parts };
  });
}

function responseInput(conversation: Conversation, messages: Message[]) {
  return apiMessages(conversation, messages).map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }]
      : message.content.map((part) => part.type === "image_url" ? { type: "input_image", image_url: part.image_url.url } : { type: "input_text", text: part.text }),
  }));
}

function contentFromResponse(data: unknown) {
  const item = data as {
    choices?: Array<{ message?: { content?: string } }>;
    output?: Array<{ type?: string; name?: string; arguments?: string; content?: Array<{ text?: string }> }>;
  };
  const chatText = item.choices?.[0]?.message?.content;
  if (chatText) return chatText;
  const toolCall = item.output?.find((part) => part.type === "function_call");
  if (toolCall) return `工具调用请求：${toolCall.name || "function"}\n\n\`\`\`json\n${toolCall.arguments || "{}"}\n\`\`\``;
  const text = item.output?.flatMap((part) => part.content || []).map((part) => part.text || "").join("").trim();
  return text || JSON.stringify(data, null, 2);
}

function contentFromSearch(data: unknown) {
  const item = data as {
    answer?: string;
    conversation_id?: string;
    sources?: Array<{ title?: string; url?: string; snippet?: string }>;
    _account_email?: string;
  };
  const answer = String(item.answer || "").trim() || JSON.stringify(data, null, 2);
  const sources = Array.isArray(item.sources) ? item.sources.filter((source) => source?.url) : [];
  const sourceText = sources.length
    ? "\n\n### 搜索来源\n" + sources.slice(0, 10).map((source, index) => {
        const title = String(source.title || source.url || `来源 ${index + 1}`).trim();
        const url = String(source.url || "").trim();
        const snippet = String(source.snippet || "").trim();
        return `${index + 1}. [${title}](${url})${snippet ? `\n   ${snippet}` : ""}`;
      }).join("\n")
    : "";
  const meta = item.conversation_id ? `\n\n> 搜索会话：${item.conversation_id}` : "";
  return `${answer}${sourceText}${meta}`.trim();
}

async function fetchJson(path: string, init: RequestInit = {}) {
  const authKey = await getStoredAuthKey();
  const response = await fetch(`${webConfig.apiUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.detail?.error || data?.error?.message || data?.error || data?.message || response.statusText;
    throw new Error(String(message));
  }
  return data;
}

async function streamChat(conversation: Conversation, messages: Message[], signal: AbortSignal, onDelta: (text: string) => void) {
  const authKey = await getStoredAuthKey();
  const response = await fetch(`${webConfig.apiUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authKey ? { Authorization: `Bearer ${authKey}` } : {}),
    },
    body: JSON.stringify({
      model: conversation.model,
      messages: apiMessages(conversation, messages),
      stream: true,
      attachments_count: messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0),
    }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        const delta = event?.choices?.[0]?.delta?.content || "";
        if (delta) onDelta(String(delta));
      } catch {
        // ignore partial SSE lines
      }
    }
  }
}

async function callModel(conversation: Conversation, messages: Message[], signal: AbortSignal) {
  const attachmentsCount = messages.reduce((sum, message) => sum + (message.attachments?.length || 0), 0);
  if (conversation.mode === "search") {
    const prompt = messages.filter((message) => message.role === "user").at(-1)?.content || "";
    const data = await fetchJson("/v1/search", {
      method: "POST",
      body: JSON.stringify({ model: conversation.model, prompt, timeout_secs: 300 }),
      signal,
    });
    return contentFromSearch(data);
  }
  if (conversation.mode === "responses" || conversation.mode === "codex") {
    const tools = conversation.mode === "codex"
      ? [
          { type: "function", name: "read_file", description: "Read a workspace file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
          { type: "function", name: "search_code", description: "Search code with ripgrep", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
          { type: "function", name: "apply_patch", description: "Apply a patch", parameters: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"] } },
          { type: "function", name: "run_tests", description: "Run a test command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
        ]
      : undefined;
    const data = await fetchJson("/v1/responses", {
      method: "POST",
      body: JSON.stringify({ model: conversation.model, input: responseInput(conversation, messages), tools, stream: false, attachments_count: attachmentsCount }),
      signal,
    });
    return contentFromResponse(data);
  }
  const data = await fetchJson("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: conversation.model, messages: apiMessages(conversation, messages), stream: false, attachments_count: attachmentsCount }),
    signal,
  });
  return contentFromResponse(data);
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function safeDownloadName(value: string, extension: string) {
  const name = value
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "AI 文件";
  return name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`;
}

function downloadGeneratedFile(filename: string, content: string) {
  downloadText(filename, content);
}

function fileRequestsFromText(content: string) {
  const items: Array<{ label: string; filename: string }> = [];
  const seen = new Set<string>();
  const typeMap: Record<string, string> = {
    ppt: "ppt",
    pptx: "pptx",
    pdf: "pdf",
    word: "docx",
    doc: "doc",
    docx: "docx",
    excel: "xlsx",
    xls: "xls",
    xlsx: "xlsx",
    csv: "csv",
    markdown: "md",
    md: "md",
    html: "html",
    txt: "txt",
  };
  const linkRe = /\[([^\]]*(?:下载|download)[^\]]*)\]\((https?:\/\/[^)]+|\/[^)]+)\)/gi;
  for (const match of content.matchAll(linkRe)) {
    const label = match[1].trim();
    if (!seen.has(label)) {
      seen.add(label);
      items.push({ label, filename: match[2] });
    }
  }
  const textRe = /(?:下载|download)\s+([^\n，。,.]{1,60}?)\s*(PPTX?|PDF|Word|DOCX?|Excel|XLSX?|CSV|Markdown|MD|HTML|TXT)\b/gi;
  for (const match of content.matchAll(textRe)) {
    const title = match[1].trim();
    const ext = typeMap[String(match[2] || "md").toLowerCase()] || "md";
    const label = `下载 ${title} ${match[2]}`;
    if (!seen.has(label)) {
      seen.add(label);
      items.push({ label, filename: safeDownloadName(title, ext) });
    }
  }
  return items.slice(0, 4);
}

export default function ChatPage() {
  const { isCheckingAuth, session } = useAuthGuard();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [view, setView] = useState<ChatView>("chat");
  const [models, setModels] = useState(DEFAULT_MODELS);
  const [chatAllowed, setChatAllowed] = useState<boolean | null>(null);
  const [chatPermissions, setChatPermissions] = useState<string[]>(DEFAULT_PERMISSIONS);
  const [isSending, setIsSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const items = readConversations();
    setConversations(items);
    setActiveId(items[0]?.id || "");
  }, []);

  useEffect(() => {
    if (conversations.length) writeConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    });
  }, [activeId, conversations]);

  useEffect(() => {
    void fetchJson("/v1/models", { method: "GET" })
      .then((data) => {
        const ids = Array.isArray(data?.data) ? data.data.map((item: { id?: string }) => String(item.id || "")).filter(Boolean) : [];
        setModels(Array.from(new Set([...DEFAULT_MODELS, ...ids])));
      })
      .catch(() => setModels(DEFAULT_MODELS));
  }, []);

  useEffect(() => {
    if (!session) {
      setChatAllowed(null);
      setChatPermissions([]);
      return;
    }
    if (session.role === "admin") {
      setChatAllowed(true);
      setChatPermissions(DEFAULT_PERMISSIONS);
      return;
    }
    let active = true;
    void fetchMyIdentity()
      .then((data) => {
        if (!active) return;
        setChatAllowed(Boolean(data.identity.chat_enabled));
        setChatPermissions(data.identity.chat_permissions || []);
      })
      .catch(() => {
        if (active) setChatAllowed(false);
      });
    return () => {
      active = false;
    };
  }, [session]);

  const active = conversations.find((item) => item.id === activeId) || conversations[0];
  const activeMessages = active?.messages || [];
  const favorites = useMemo(() => conversations.flatMap((conversation) => conversation.messages.filter((message) => message.favorite).map((message) => ({ conversation, message }))), [conversations]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return [...conversations]
      .filter((conversation) => !needle || conversation.title.toLowerCase().includes(needle) || (conversation.category || "").toLowerCase().includes(needle) || conversation.messages.some((message) => message.content.toLowerCase().includes(needle)))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [conversations, query]);

  const updateActive = (updater: (conversation: Conversation) => Conversation) => {
    setConversations((items) => items.map((item) => item.id === activeId ? updater(item) : item));
  };

  const createNewConversation = () => {
    const item = createConversation();
    setConversations((items) => [item, ...items]);
    setActiveId(item.id);
    setDraft("");
    setAttachments([]);
  };

  const readFiles = async (files: FileList | File[]) => {
    if (!chatPermissions.includes("attachments")) {
      toast.error("当前账号没有附件上传权限");
      return;
    }
    const next: Attachment[] = [];
    for (const file of Array.from(files).slice(0, 8)) {
      if (file.size > 4 * 1024 * 1024) {
        toast.error(`${file.name} 超过 4MB，已跳过`);
        continue;
      }
      if (file.type.startsWith("image/")) {
        if (!chatPermissions.includes("image_understanding")) {
          toast.error("当前账号没有图片理解权限");
          continue;
        }
        const content = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        next.push({ id: nowId("file"), name: file.name, type: file.type, size: file.size, kind: "image", content });
      } else if (file.type.startsWith("text/") || /\.(md|txt|json|csv|ts|tsx|js|jsx|py|go|rs|java|cs|html|css|xml|yaml|yml|toml)$/i.test(file.name)) {
        next.push({ id: nowId("file"), name: file.name, type: file.type, size: file.size, kind: "text", content: await file.text() });
      } else {
        next.push({ id: nowId("file"), name: file.name, type: file.type, size: file.size, kind: "binary", content: "" });
      }
    }
    setAttachments((items) => [...items, ...next]);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (!files.length) return;
    event.preventDefault();
    void readFiles(files);
  };

  const submit = async (event?: FormEvent, override?: string) => {
    event?.preventDefault();
    if (!active || isSending) return;
    if (chatAllowed === false || !chatPermissions.includes("chat")) {
      toast.error("当前账号没有普通聊天权限");
      return;
    }
    if (active.mode === "codex" && !chatPermissions.includes("code")) {
      toast.error("当前账号没有代码能力权限");
      return;
    }
    if (active.mode === "search" && !chatPermissions.includes("web")) {
      toast.error("当前账号没有联网搜索权限");
      return;
    }
    if (attachments.length && !chatPermissions.includes("attachments")) {
      toast.error("当前账号没有附件上传权限");
      return;
    }
    const content = String(override ?? draft).trim();
    if (!content && !attachments.length) return;

    const userMessage: Message = { id: nowId("msg"), role: "user", content: `${content}${attachmentText(attachments)}`.trim(), createdAt: Date.now(), attachments };
    const nextMessages = [...active.messages, userMessage];
    const assistantId = nowId("msg");
    const optimistic = active.mode === "chat" ? [...nextMessages, { id: assistantId, role: "assistant" as const, content: "", createdAt: Date.now(), model: active.model }] : nextMessages;
    updateActive((conversation) => ({ ...conversation, title: conversation.title === "新对话" ? titleFromText(content || attachments[0]?.name || "新对话") : conversation.title, messages: optimistic, updatedAt: Date.now() }));
    setDraft("");
    setAttachments([]);
    setIsSending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (active.mode === "chat") {
        let text = "";
        await streamChat(active, nextMessages, controller.signal, (delta) => {
          text += delta;
          updateActive((conversation) => ({ ...conversation, messages: conversation.messages.map((message) => message.id === assistantId ? { ...message, content: text } : message), updatedAt: Date.now() }));
        });
        if (!text.trim()) {
          const fallback = await callModel(active, nextMessages, controller.signal);
          updateActive((conversation) => ({ ...conversation, messages: conversation.messages.map((message) => message.id === assistantId ? { ...message, content: fallback } : message), updatedAt: Date.now() }));
        }
      } else {
        const text = await callModel(active, nextMessages, controller.signal);
        updateActive((conversation) => ({ ...conversation, messages: [...nextMessages, { id: assistantId, role: "assistant", content: text, createdAt: Date.now(), model: active.model }], updatedAt: Date.now() }));
      }
    } catch (error) {
      if (!controller.signal.aborted) toast.error(error instanceof Error ? error.message : "对话失败");
      updateActive((conversation) => ({ ...conversation, messages: conversation.messages.filter((message) => message.id !== assistantId), updatedAt: Date.now() }));
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setIsSending(false);
  };

  const setMode = (mode: ChatMode) => updateActive((conversation) => ({ ...conversation, mode, updatedAt: Date.now() }));
  const setModel = (model: string) => updateActive((conversation) => ({ ...conversation, model, updatedAt: Date.now() }));
  const copyText = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast.success("已复制");
  };

  if (isCheckingAuth || !active) {
    return <div className="grid min-h-[50vh] place-items-center"><LoaderCircle className="size-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <section className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[1640px] flex-col gap-3 py-3 sm:h-[calc(100dvh-5rem)] sm:py-4">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-foreground text-background"><MessageCircle className="size-5" /></span>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">AI 对话工作台</h1>
            <p className="truncate text-xs text-muted-foreground">{session?.name || "当前账号"} · 对话 / 搜索 / Responses / Codex 工具调用预览</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={createNewConversation}><Plus className="size-4" /><span className="hidden sm:inline">新对话</span></Button>
          <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={() => downloadText(`${active.title}.md`, active.messages.map((message) => `## ${message.role}\n\n${message.content}`).join("\n\n"))}><Download className="size-4" /><span className="hidden sm:inline">导出</span></Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
        <aside className="hidden min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:flex">
          <div className="border-b border-border p-3">
            <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话、分类、内容" className="h-10 rounded-xl pl-9" /></div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {filtered.map((item) => (
              <button key={item.id} type="button" onClick={() => setActiveId(item.id)} className={cn("mb-2 w-full rounded-xl border p-3 text-left text-sm", item.id === active.id ? "border-foreground bg-foreground text-background" : "border-border bg-background")}>
                <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>{item.pinned ? <Pin className="size-3" /> : null}</div>
                <div className={cn("mt-1 truncate text-xs", item.id === active.id ? "text-background/70" : "text-muted-foreground")}>{item.category || item.mode} · {formatTime(item.updatedAt)}</div>
              </button>
            ))}
          </div>
        </aside>

        <main className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex shrink-0 items-center justify-between border-b border-border p-3">
            <div className="flex min-w-0 items-center gap-2">
              <Button type="button" variant={view === "chat" ? "default" : "outline"} className="h-8 rounded-xl text-xs" onClick={() => setView("chat")}>对话</Button>
              <Button type="button" variant={view === "prompts" ? "default" : "outline"} className="h-8 rounded-xl text-xs" onClick={() => setView("prompts")}>模板</Button>
              <Button type="button" variant={view === "favorites" ? "default" : "outline"} className="h-8 rounded-xl text-xs" onClick={() => setView("favorites")}>收藏</Button>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" className="size-8 rounded-lg" onClick={() => updateActive((conversation) => ({ ...conversation, pinned: !conversation.pinned, updatedAt: Date.now() }))}>{active.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}</Button>
              <Button type="button" variant="ghost" className="size-8 rounded-lg" onClick={() => updateActive((conversation) => ({ ...conversation, messages: [], updatedAt: Date.now() }))}><Trash2 className="size-4" /></Button>
            </div>
          </div>

          {view === "chat" ? (
            <>
              <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto p-4">
                {activeMessages.length === 0 ? (
                  <div className="grid min-h-80 place-items-center text-center text-sm text-muted-foreground">
                    <div><Bot className="mx-auto mb-3 size-8" /><div>开始一个普通对话，或切到搜索 / Responses / Codex 模式。</div></div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activeMessages.map((message) => {
                      const isUser = message.role === "user";
                      const fileRequests = isUser ? [] : fileRequestsFromText(message.content);
                      return (
                        <div key={message.id} className={cn("group flex", isUser ? "justify-end" : "justify-start")}>
                          <div className={cn("max-w-[92%] space-y-2 sm:max-w-[78%]", isUser ? "items-end" : "items-start")}>
                            <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", isUser && "justify-end")}><span>{isUser ? "你" : "AI"}</span><span>{formatTime(message.createdAt)}</span>{message.model ? <span>{message.model}</span> : null}</div>
                            <div className={cn("overflow-hidden rounded-xl px-4 py-3 text-sm leading-6", isUser ? "bg-foreground text-background" : "border border-border bg-background text-foreground")}>
                              <div className={cn("prose prose-sm max-w-none break-words dark:prose-invert", isUser && "prose-invert")}><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || (isSending ? "..." : "")}</ReactMarkdown></div>
                              {message.attachments?.length ? <div className="mt-3 flex flex-wrap gap-2">{message.attachments.map((file) => <span key={file.id} className="inline-flex items-center gap-1 rounded-lg bg-background/10 px-2 py-1 text-xs">{file.kind === "image" ? <ImageIcon className="size-3" /> : <FileText className="size-3" />}{file.name}</span>)}</div> : null}
                              {fileRequests.length ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {fileRequests.map((file) => (
                                    file.filename.startsWith("http") || file.filename.startsWith("/") ? (
                                      <a key={file.label} href={file.filename} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary">
                                        <Download className="size-3" />
                                        {file.label}
                                      </a>
                                    ) : (
                                      <button key={file.label} type="button" onClick={() => downloadGeneratedFile(file.filename, message.content)} className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-secondary">
                                        <Download className="size-3" />
                                        {file.label}
                                      </button>
                                    )
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <div className={cn("flex flex-wrap gap-1 opacity-100 sm:opacity-0 sm:transition sm:group-hover:opacity-100", isUser && "justify-end")}>
                              <Button type="button" variant="ghost" className="h-7 rounded-lg px-2 text-xs" onClick={() => void copyText(message.content)}><Copy className="size-3" />复制</Button>
                              <Button type="button" variant="ghost" className="h-7 rounded-lg px-2 text-xs" onClick={() => updateActive((conversation) => ({ ...conversation, messages: conversation.messages.map((item) => item.id === message.id ? { ...item, favorite: !item.favorite } : item), updatedAt: Date.now() }))}><Star className={cn("size-3", message.favorite && "fill-current")} />收藏</Button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <form onSubmit={(event) => void submit(event)} className="shrink-0 border-t border-border p-3">
                {attachments.length ? <div className="mb-2 flex flex-wrap gap-2">{attachments.map((file) => <span key={file.id} className="inline-flex max-w-full items-center gap-2 rounded-lg border border-border bg-background px-2 py-1 text-xs">{file.kind === "image" ? <ImageIcon className="size-3" /> : <FileText className="size-3" />}<span className="truncate">{file.name}</span><span className="text-muted-foreground">{formatBytes(file.size)}</span><button type="button" onClick={() => setAttachments((items) => items.filter((item) => item.id !== file.id))}><X className="size-3" /></button></span>)}</div> : null}
                {chatAllowed === false ? <div className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">当前账号没有 AI 对话权限，请联系管理员开启。</div> : null}
                <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2">
                  <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) void readFiles(event.target.files); event.currentTarget.value = ""; }} />
                  <Button type="button" variant="ghost" className="size-10 shrink-0 rounded-xl" onClick={() => fileInputRef.current?.click()} disabled={chatAllowed === false || !chatPermissions.includes("attachments")} title="上传附件"><Upload className="size-4" /></Button>
                  <Textarea value={draft} onChange={(event) => setDraft(event.target.value)} onPaste={handlePaste} placeholder="输入消息，Enter 发送，Shift+Enter 换行" className="max-h-48 min-h-12 flex-1 resize-none border-0 bg-transparent px-2 py-3 shadow-none focus-visible:ring-0" disabled={isSending || chatAllowed === false} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); } }} />
                  <Button type="button" variant="ghost" className="size-10 shrink-0 rounded-xl" title="语音输入"><Mic className="size-4" /></Button>
                  {isSending ? <Button type="button" className="size-10 shrink-0 rounded-xl" onClick={stop}><StopCircle className="size-4" /></Button> : <Button type="submit" className="size-10 shrink-0 rounded-xl" disabled={chatAllowed === false || (!draft.trim() && !attachments.length)}><Send className="size-4" /></Button>}
                </div>
              </form>
            </>
          ) : null}

          {view === "prompts" ? <div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{PROMPTS.map((prompt) => <button key={prompt.id} type="button" className="rounded-xl border border-border bg-background p-4 text-left transition hover:border-foreground/20" onClick={() => { setDraft((text) => `${text}${text ? "\n\n" : ""}${prompt.text}`); setView("chat"); }}><div className="mb-2 flex items-center justify-between gap-2"><span className="font-medium">{prompt.name}</span><span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{prompt.category}</span></div><p className="line-clamp-4 text-sm text-muted-foreground">{prompt.text}</p></button>)}</div></div> : null}
          {view === "favorites" ? <div className="min-h-0 flex-1 overflow-y-auto p-3">{favorites.length ? <div className="space-y-3">{favorites.map(({ conversation, message }) => <button key={`${conversation.id}-${message.id}`} type="button" className="w-full rounded-xl border border-border bg-background p-4 text-left" onClick={() => { setActiveId(conversation.id); setView("chat"); }}><div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{conversation.title}</span><span>{formatTime(message.createdAt)}</span></div><p className="line-clamp-4 whitespace-pre-wrap text-sm">{message.content}</p></button>)}</div> : <div className="grid min-h-80 place-items-center text-sm text-muted-foreground">还没有收藏消息</div>}</div> : null}
        </main>

        <aside className="hidden min-h-0 overflow-y-auto rounded-xl border border-border bg-card p-3 lg:block">
          <div className="space-y-4">
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Settings2 className="size-4" />参数</div>
              <div className="grid grid-cols-2 gap-2">
                <Select value={active.mode} onValueChange={(value) => setMode(value as ChatMode)}>
                  <SelectTrigger className="h-10 rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="chat">普通对话</SelectItem><SelectItem value="search">联网搜索</SelectItem><SelectItem value="responses">Responses</SelectItem><SelectItem value="codex">Codex 写代码</SelectItem></SelectContent>
                </Select>
                <Select value={active.model} onValueChange={setModel}>
                  <SelectTrigger className="h-10 rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>{models.map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Input value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} placeholder="会话分类" className="h-10 rounded-xl" onKeyDown={(event) => { if (event.key === "Enter") { updateActive((conversation) => ({ ...conversation, category: categoryDraft.trim(), updatedAt: Date.now() })); setCategoryDraft(""); } }} />
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-md bg-muted px-2 py-1">权限：{chatPermissions.join(" / ") || "无"}</span>
                {active.category ? <span className="rounded-md bg-muted px-2 py-1">分类：{active.category}</span> : null}
              </div>
            </section>
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Wrench className="size-4" />操作</div>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" variant="outline" className="h-9 rounded-xl justify-start text-xs" onClick={() => void submit(undefined, active.messages.filter((message) => message.role === "user").at(-1)?.content || "")} disabled={isSending}><Pencil className="size-4" />重新生成</Button>
                <Button type="button" variant="outline" className="h-9 rounded-xl justify-start text-xs" onClick={() => updateActive((conversation) => ({ ...conversation, messages: [], updatedAt: Date.now() }))}><Trash2 className="size-4" />清空</Button>
                <Button type="button" variant="outline" className="h-9 rounded-xl justify-start text-xs" onClick={() => void copyText(active.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"))}><Copy className="size-4" />复制全文</Button>
                <Button type="button" variant="outline" className="h-9 rounded-xl justify-start text-xs" onClick={() => downloadText(`${active.title}.json`, JSON.stringify(active, null, 2))}><Download className="size-4" />JSON</Button>
              </div>
            </section>
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium"><Code2 className="size-4" />Codex 模式</div>
              <div className="rounded-xl border border-border bg-background p-3 text-xs leading-5 text-muted-foreground">Codex 模式会通过 Responses API 产生受控工具调用请求，当前 Web 页只展示工具调用 JSON，不直接操作服务器文件。</div>
            </section>
          </div>
        </aside>
      </div>
    </section>
  );
}
