"use client";

import { useEffect, useMemo, useState } from "react";
import { Ban, CheckCircle2, Copy, Infinity as InfinityIcon, KeyRound, LoaderCircle, MessageCircle, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createUserKey, deleteUserKey, fetchUserKeys, updateUserKey, type UserKey } from "@/lib/api";

let cachedItems: UserKey[] | null = null;

const commerceFeatureOptions = [
  { key: "detail", label: "详情页分图" },
  { key: "main", label: "爆款主图" },
  { key: "buyer", label: "买家秀" },
  { key: "white", label: "白底图" },
  { key: "replace", label: "批量替换主体" },
  { key: "resize", label: "尺寸转换" },
  { key: "sku", label: "批量 SKU 出图" },
  { key: "ab", label: "A/B 测试图" },
  { key: "competitor", label: "竞品图复刻增强" },
];

const apiPermissionOptions = [
  { key: "chat", label: "Chat" },
  { key: "responses", label: "Responses" },
  { key: "images", label: "Images" },
  { key: "models", label: "Models" },
  { key: "messages", label: "Messages" },
  { key: "image_tasks", label: "Image Tasks" },
];

const chatPermissionOptions = [
  { key: "chat", label: "普通聊天" },
  { key: "attachments", label: "附件上传" },
  { key: "web", label: "联网能力" },
  { key: "code", label: "代码能力" },
  { key: "image_understanding", label: "图片理解" },
];

function parseList(value: string) {
  return value.split(/[\n,，\s]+/).map((item) => item.trim()).filter(Boolean);
}

function sameSet(a: string[], b: string[]) {
  return [...new Set(a)].sort().join(",") === [...new Set(b)].sort().join(",");
}

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}

function toggleValue(values: string[], key: string, checked: boolean) {
  return checked ? [...new Set([...values, key])] : values.filter((item) => item !== key);
}

function PermissionChecks({ values, onChange, options }: { values: string[]; onChange: (values: string[]) => void; options: Array<{ key: string; label: string }> }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {options.map((option) => (
        <label key={option.key} className="flex cursor-pointer items-center gap-2 text-sm text-stone-700">
          <Checkbox checked={values.includes(option.key)} onCheckedChange={(checked) => onChange(toggleValue(values, option.key, Boolean(checked)))} />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}

export function UserKeysCard() {
  const [items, setItemsState] = useState<UserKey[]>(() => cachedItems ?? []);
  const [isLoading, setIsLoading] = useState(() => cachedItems === null);
  const [revealedKey, setRevealedKey] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deletingItem, setDeletingItem] = useState<UserKey | null>(null);
  const [editingItem, setEditingItem] = useState<UserKey | null>(null);

  const [name, setName] = useState("");
  const [quota, setQuota] = useState("100");
  const [unlimited, setUnlimited] = useState(false);
  const [chatEnabled, setChatEnabled] = useState(false);
  const [commercePermissions, setCommercePermissions] = useState<string[]>([]);
  const [allowedModels, setAllowedModels] = useState("");
  const [apiPermissions, setApiPermissions] = useState<string[]>(apiPermissionOptions.map((item) => item.key));
  const [maxConcurrency, setMaxConcurrency] = useState("0");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [chatPermissions, setChatPermissions] = useState<string[]>([]);

  const [editName, setEditName] = useState("");
  const [editKey, setEditKey] = useState("");
  const [editQuota, setEditQuota] = useState("");
  const [editQuotaMode, setEditQuotaMode] = useState<"add" | "set">("add");
  const [editUnlimited, setEditUnlimited] = useState(false);
  const [editChatEnabled, setEditChatEnabled] = useState(false);
  const [editCommercePermissions, setEditCommercePermissions] = useState<string[]>([]);
  const [editAllowedModels, setEditAllowedModels] = useState("");
  const [editApiPermissions, setEditApiPermissions] = useState<string[]>([]);
  const [editMaxConcurrency, setEditMaxConcurrency] = useState("0");
  const [editWebhookUrl, setEditWebhookUrl] = useState("");
  const [editChatPermissions, setEditChatPermissions] = useState<string[]>([]);
  const [editResetUsed, setEditResetUsed] = useState(false);

  const setItems = (next: UserKey[]) => {
    cachedItems = next;
    setItemsState(next);
  };

  const load = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const data = await fetchUserKeys();
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "加载用户密钥失败");
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  useEffect(() => {
    void load(cachedItems !== null);
  }, []);

  const createPayload = useMemo(() => ({
    name: name.trim(),
    quota: unlimited ? 0 : Math.max(0, Math.floor(Number(quota) || 0)),
    unlimited,
    chat_enabled: chatEnabled,
    commerce_permissions: commercePermissions,
    allowed_models: parseList(allowedModels),
    api_permissions: apiPermissions,
    max_concurrency: Math.max(0, Math.floor(Number(maxConcurrency) || 0)),
    webhook_url: webhookUrl.trim(),
    chat_permissions: chatPermissions,
  }), [allowedModels, apiPermissions, chatEnabled, chatPermissions, commercePermissions, maxConcurrency, name, quota, unlimited, webhookUrl]);

  const handleCreate = async () => {
    if (!createPayload.unlimited && createPayload.quota <= 0) {
      toast.error("请填写大于 0 的额度，或勾选不限额度");
      return;
    }
    setIsCreating(true);
    try {
      const data = await createUserKey(createPayload);
      setItems(data.items);
      setRevealedKey(data.key);
      setName("");
      setQuota("100");
      setUnlimited(false);
      setChatEnabled(false);
      setCommercePermissions([]);
      setAllowedModels("");
      setApiPermissions(apiPermissionOptions.map((item) => item.key));
      setMaxConcurrency("0");
      setWebhookUrl("");
      setChatPermissions([]);
      setIsCreateOpen(false);
      toast.success("用户密钥已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败");
    } finally {
      setIsCreating(false);
    }
  };

  const setPending = (id: string, pending: boolean) => {
    setPendingIds((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const openEdit = (item: UserKey) => {
    setEditingItem(item);
    setEditName(item.name);
    setEditKey("");
    setEditQuota("");
    setEditQuotaMode("add");
    setEditUnlimited(Boolean(item.unlimited));
    setEditChatEnabled(Boolean(item.chat_enabled));
    setEditCommercePermissions(item.commerce_permissions ?? []);
    setEditAllowedModels((item.allowed_models ?? []).join(", "));
    setEditApiPermissions(item.api_permissions?.length ? item.api_permissions : apiPermissionOptions.map((option) => option.key));
    setEditMaxConcurrency(String(item.max_concurrency ?? 0));
    setEditWebhookUrl(item.webhook_url ?? "");
    setEditChatPermissions(item.chat_permissions ?? []);
    setEditResetUsed(false);
  };

  const handleEdit = async () => {
    if (!editingItem) return;
    const item = editingItem;
    const quotaInput = editQuota.trim();
    const quotaInputNum = quotaInput === "" ? 0 : Math.max(0, Math.floor(Number(quotaInput) || 0));
    const nextQuota = editUnlimited ? 0 : editQuotaMode === "add" ? Math.max(0, (item.quota || 0) + quotaInputNum) : quotaInputNum;
    const payload = {
      ...(editName.trim() !== item.name ? { name: editName.trim() } : {}),
      ...(editKey.trim() ? { key: editKey.trim() } : {}),
      ...(editUnlimited !== Boolean(item.unlimited) ? { unlimited: editUnlimited } : {}),
      ...(!editUnlimited && quotaInput !== "" && nextQuota !== item.quota ? { quota: nextQuota } : {}),
      ...(editChatEnabled !== Boolean(item.chat_enabled) ? { chat_enabled: editChatEnabled } : {}),
      ...(!sameSet(editCommercePermissions, item.commerce_permissions ?? []) ? { commerce_permissions: editCommercePermissions } : {}),
      ...(!sameSet(parseList(editAllowedModels), item.allowed_models ?? []) ? { allowed_models: parseList(editAllowedModels) } : {}),
      ...(!sameSet(editApiPermissions, item.api_permissions ?? apiPermissionOptions.map((option) => option.key)) ? { api_permissions: editApiPermissions } : {}),
      ...(Math.max(0, Math.floor(Number(editMaxConcurrency) || 0)) !== (item.max_concurrency ?? 0) ? { max_concurrency: Math.max(0, Math.floor(Number(editMaxConcurrency) || 0)) } : {}),
      ...(editWebhookUrl.trim() !== (item.webhook_url ?? "") ? { webhook_url: editWebhookUrl.trim() } : {}),
      ...(!sameSet(editChatPermissions, item.chat_permissions ?? []) ? { chat_permissions: editChatPermissions } : {}),
      ...(editResetUsed ? { reset_used: true } : {}),
    };
    if (Object.keys(payload).length === 0) {
      setEditingItem(null);
      return;
    }
    setPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, payload);
      setItems(data.items);
      setEditingItem(null);
      toast.success("用户密钥已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      setPending(item.id, false);
    }
  };

  const handleToggle = async (item: UserKey) => {
    setPending(item.id, true);
    try {
      const data = await updateUserKey(item.id, { enabled: !item.enabled });
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      setPending(item.id, false);
    }
  };

  const handleChatToggle = async (item: UserKey) => {
    setPending(item.id, true);
    try {
      const nextEnabled = !item.chat_enabled;
      const data = await updateUserKey(item.id, {
        chat_enabled: nextEnabled,
        ...(nextEnabled && !(item.chat_permissions || []).includes("chat") ? { chat_permissions: ["chat", ...(item.chat_permissions || [])] } : {}),
      });
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新失败");
    } finally {
      setPending(item.id, false);
    }
  };

  const handleDelete = async () => {
    if (!deletingItem) return;
    setPending(deletingItem.id, true);
    try {
      const data = await deleteUserKey(deletingItem.id);
      setItems(data.items);
      setDeletingItem(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setPending(deletingItem.id, false);
    }
  };

  const copyKey = async () => {
    await navigator.clipboard.writeText(revealedKey);
    toast.success("已复制");
  };

  return (
    <>
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="space-y-6 p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100"><KeyRound className="size-5 text-stone-600" /></div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">用户密钥管理</h2>
                <p className="text-sm text-stone-500">为普通用户创建专用密钥，支持模型、接口、并发、Webhook、对话能力和电商功能权限控制。</p>
              </div>
            </div>
            <Button className="h-9 rounded-xl bg-stone-950 px-4 text-white hover:bg-stone-800" onClick={() => setIsCreateOpen(true)}>
              <Plus className="size-4" /> 创建用户密钥
            </Button>
          </div>

          {revealedKey ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <div className="font-medium">新密钥仅展示一次：</div>
              <div className="mt-3 flex flex-col gap-3 rounded-lg border border-emerald-200 bg-white/80 p-3 md:flex-row md:items-center md:justify-between">
                <code className="break-all font-mono text-[13px]">{revealedKey}</code>
                <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={() => void copyKey()}><Copy className="size-4" /> 复制</Button>
              </div>
            </div>
          ) : null}

          {isLoading ? (
            <div className="flex items-center justify-center py-10"><LoaderCircle className="size-5 animate-spin text-stone-400" /></div>
          ) : items.length === 0 ? (
            <div className="rounded-xl bg-stone-50 px-6 py-10 text-center text-sm text-stone-500">暂无普通用户密钥</div>
          ) : (
            <div className="space-y-3">
              {items.map((item) => {
                const isPending = pendingIds.has(item.id);
                const remaining = item.unlimited ? null : Math.max(0, (item.quota || 0) - (item.used || 0));
                const tokens = (item.usage?.input_tokens || 0) + (item.usage?.output_tokens || 0);
                return (
                  <div key={item.id} className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white px-4 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="truncate text-sm font-medium text-stone-800">{item.name}</div>
                        <Badge variant={item.enabled ? "success" : "secondary"} className="rounded-md">{item.enabled ? "已启用" : "已禁用"}</Badge>
                        <Badge variant={item.chat_enabled ? "success" : "secondary"} className="rounded-md"><MessageCircle className="size-3" />{item.chat_enabled ? "对话开" : "对话关"}</Badge>
                        <Badge variant="secondary" className="rounded-md">电商 {item.commerce_permissions?.length || 0}</Badge>
                        <Badge variant="secondary" className="rounded-md">API {item.api_permissions?.length || apiPermissionOptions.length}</Badge>
                        <Badge variant="secondary" className="rounded-md">模型 {item.allowed_models?.length ? item.allowed_models.length : "全部"}</Badge>
                        {item.max_concurrency ? <Badge variant="secondary" className="rounded-md">并发 {item.max_concurrency}</Badge> : null}
                        {item.unlimited ? <Badge variant="secondary" className="rounded-md bg-violet-50 text-violet-700"><InfinityIcon className="size-3" />不限额度</Badge> : null}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                        <span className="font-data tabular-nums text-stone-700">{item.unlimited ? `已用 ${item.used || 0} / 不限` : `额度 ${item.used || 0} / ${item.quota || 0}（剩 ${remaining}）`}</span>
                        <span>创建 {formatDateTime(item.created_at)}</span>
                        <span>最近 {formatDateTime(item.last_used_at)}</span>
                        <span>Chat {item.usage?.chat_calls || 0}</span>
                        <span>Resp {item.usage?.response_calls || 0}</span>
                        <span>Img {item.usage?.images || 0}</span>
                        <span>Tok {tokens}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={() => openEdit(item)} disabled={isPending}>{isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Pencil className="size-4" />} 编辑</Button>
                      <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={() => void handleChatToggle(item)} disabled={isPending}><MessageCircle className="size-4" />{item.chat_enabled ? "关对话" : "开对话"}</Button>
                      <Button type="button" variant="outline" className="h-9 rounded-xl" onClick={() => void handleToggle(item)} disabled={isPending}>{item.enabled ? <Ban className="size-4" /> : <CheckCircle2 className="size-4" />}{item.enabled ? "禁用" : "启用"}</Button>
                      <Button type="button" variant="outline" className="h-9 rounded-xl border-rose-200 text-rose-600" onClick={() => setDeletingItem(item)} disabled={isPending}><Trash2 className="size-4" />删除</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <KeyDialog
        mode="create"
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        name={name}
        setName={setName}
        quota={quota}
        setQuota={setQuota}
        unlimited={unlimited}
        setUnlimited={setUnlimited}
        chatEnabled={chatEnabled}
        setChatEnabled={setChatEnabled}
        commercePermissions={commercePermissions}
        setCommercePermissions={setCommercePermissions}
        allowedModels={allowedModels}
        setAllowedModels={setAllowedModels}
        apiPermissions={apiPermissions}
        setApiPermissions={setApiPermissions}
        maxConcurrency={maxConcurrency}
        setMaxConcurrency={setMaxConcurrency}
        webhookUrl={webhookUrl}
        setWebhookUrl={setWebhookUrl}
        chatPermissions={chatPermissions}
        setChatPermissions={setChatPermissions}
        onSubmit={() => void handleCreate()}
        isPending={isCreating}
      />

      <KeyDialog
        mode="edit"
        open={Boolean(editingItem)}
        onOpenChange={(open) => !open && setEditingItem(null)}
        name={editName}
        setName={setEditName}
        quota={editQuota}
        setQuota={setEditQuota}
        unlimited={editUnlimited}
        setUnlimited={setEditUnlimited}
        chatEnabled={editChatEnabled}
        setChatEnabled={setEditChatEnabled}
        commercePermissions={editCommercePermissions}
        setCommercePermissions={setEditCommercePermissions}
        allowedModels={editAllowedModels}
        setAllowedModels={setEditAllowedModels}
        apiPermissions={editApiPermissions}
        setApiPermissions={setEditApiPermissions}
        maxConcurrency={editMaxConcurrency}
        setMaxConcurrency={setEditMaxConcurrency}
        webhookUrl={editWebhookUrl}
        setWebhookUrl={setEditWebhookUrl}
        chatPermissions={editChatPermissions}
        setChatPermissions={setEditChatPermissions}
        editKey={editKey}
        setEditKey={setEditKey}
        editQuotaMode={editQuotaMode}
        setEditQuotaMode={setEditQuotaMode}
        editResetUsed={editResetUsed}
        setEditResetUsed={setEditResetUsed}
        onSubmit={() => void handleEdit()}
        isPending={editingItem ? pendingIds.has(editingItem.id) : false}
      />

      <Dialog open={Boolean(deletingItem)} onOpenChange={(open) => !open && setDeletingItem(null)}>
        <DialogContent className="rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle>删除用户密钥</DialogTitle>
            <DialogDescription>确认删除「{deletingItem?.name}」吗？删除后该密钥将无法继续调用接口。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setDeletingItem(null)}>取消</Button>
            <Button type="button" className="bg-rose-600 text-white hover:bg-rose-700" onClick={() => void handleDelete()}><Trash2 className="size-4" />删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type KeyDialogProps = {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  setName: (value: string) => void;
  quota: string;
  setQuota: (value: string) => void;
  unlimited: boolean;
  setUnlimited: (value: boolean) => void;
  chatEnabled: boolean;
  setChatEnabled: (value: boolean) => void;
  commercePermissions: string[];
  setCommercePermissions: (value: string[]) => void;
  allowedModels: string;
  setAllowedModels: (value: string) => void;
  apiPermissions: string[];
  setApiPermissions: (value: string[]) => void;
  maxConcurrency: string;
  setMaxConcurrency: (value: string) => void;
  webhookUrl: string;
  setWebhookUrl: (value: string) => void;
  chatPermissions: string[];
  setChatPermissions: (value: string[]) => void;
  onSubmit: () => void;
  isPending: boolean;
  editKey?: string;
  setEditKey?: (value: string) => void;
  editQuotaMode?: "add" | "set";
  setEditQuotaMode?: (value: "add" | "set") => void;
  editResetUsed?: boolean;
  setEditResetUsed?: (value: boolean) => void;
};

function KeyDialog(props: KeyDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-2xl p-6 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{props.mode === "create" ? "创建用户密钥" : "编辑用户密钥"}</DialogTitle>
          <DialogDescription>普通用户默认无对话能力，管理员可按接口、模型、并发、功能逐项授权。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-2 text-sm font-medium text-stone-700">名称<Input value={props.name} onChange={(event) => props.setName(event.target.value)} className="h-10 rounded-xl" /></label>
            <label className="space-y-2 text-sm font-medium text-stone-700">画图额度<Input type="number" min={0} value={props.quota} onChange={(event) => props.setQuota(event.target.value)} disabled={props.unlimited} className="h-10 rounded-xl" /></label>
          </div>
          {props.mode === "edit" && props.setEditQuotaMode ? (
            <div className="inline-flex rounded-lg border border-stone-200 bg-stone-50 p-0.5 text-xs">
              <button type="button" className={`rounded-md px-3 py-1 ${props.editQuotaMode === "add" ? "bg-white shadow-sm" : ""}`} onClick={() => props.setEditQuotaMode?.("add")}>追加额度</button>
              <button type="button" className={`rounded-md px-3 py-1 ${props.editQuotaMode === "set" ? "bg-white shadow-sm" : ""}`} onClick={() => props.setEditQuotaMode?.("set")}>覆盖额度</button>
            </div>
          ) : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700"><Checkbox checked={props.unlimited} onCheckedChange={(checked) => props.setUnlimited(Boolean(checked))} />不限额度</label>
            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-700"><Checkbox checked={props.chatEnabled} onCheckedChange={(checked) => props.setChatEnabled(Boolean(checked))} />允许 AI 对话</label>
          </div>
          <section className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="text-sm font-medium text-stone-700">电商区功能权限</div>
            <PermissionChecks values={props.commercePermissions} onChange={props.setCommercePermissions} options={commerceFeatureOptions} />
          </section>
          <section className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="text-sm font-medium text-stone-700">API Key 权限细分</div>
            <Input value={props.allowedModels} onChange={(event) => props.setAllowedModels(event.target.value)} placeholder="允许模型，留空为全部。例：gpt-5,gpt-image-2" className="h-10 rounded-xl bg-white" />
            <PermissionChecks values={props.apiPermissions} onChange={props.setApiPermissions} options={apiPermissionOptions} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input type="number" min={0} value={props.maxConcurrency} onChange={(event) => props.setMaxConcurrency(event.target.value)} placeholder="最大并发，0 不限" className="h-10 rounded-xl bg-white" />
              <Input value={props.webhookUrl} onChange={(event) => props.setWebhookUrl(event.target.value)} placeholder="Webhook URL（任务完成回调）" className="h-10 rounded-xl bg-white" />
            </div>
          </section>
          <section className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
            <div className="text-sm font-medium text-stone-700">对话权限细分</div>
            <PermissionChecks values={props.chatPermissions} onChange={props.setChatPermissions} options={chatPermissionOptions} />
          </section>
          {props.mode === "edit" ? (
            <section className="space-y-3 rounded-lg border border-stone-200 bg-stone-50 p-3">
              <Input value={props.editKey || ""} onChange={(event) => props.setEditKey?.(event.target.value)} placeholder="新的专用密钥（可选）" className="h-10 rounded-xl bg-white font-mono" />
              <button type="button" onClick={() => props.setEditResetUsed?.(!props.editResetUsed)} className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs ${props.editResetUsed ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-stone-200 bg-white text-stone-600"}`}>
                <RotateCcw className="size-3.5" />{props.editResetUsed ? "保存时重置已用额度" : "重置已用额度"}
              </button>
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={() => props.onOpenChange(false)} disabled={props.isPending}>取消</Button>
          <Button type="button" className="bg-stone-950 text-white hover:bg-stone-800" onClick={props.onSubmit} disabled={props.isPending}>{props.isPending ? <LoaderCircle className="size-4 animate-spin" /> : props.mode === "create" ? <Plus className="size-4" /> : <Pencil className="size-4" />}{props.mode === "create" ? "创建" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
