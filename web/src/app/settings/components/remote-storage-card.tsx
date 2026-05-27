"use client";

import { Cloud, LoaderCircle, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettingsStore } from "../store";

export function RemoteStorageCard() {
  const config = useSettingsStore((state) => state.config);
  const isLoadingConfig = useSettingsStore((state) => state.isLoadingConfig);
  const isTestingRemoteStorage = useSettingsStore((state) => state.isTestingRemoteStorage);
  const setRemoteStorageField = useSettingsStore((state) => state.setRemoteStorageField);
  const setRemoteStorageNestedField = useSettingsStore((state) => state.setRemoteStorageNestedField);
  const testRemoteStorage = useSettingsStore((state) => state.testRemoteStorage);

  if (isLoadingConfig) {
    return (
      <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
        <CardContent className="flex items-center justify-center p-10">
          <LoaderCircle className="size-5 animate-spin text-stone-400" />
        </CardContent>
      </Card>
    );
  }

  const remote = config?.remote_storage;
  if (!remote) return null;
  const provider = String(remote.provider || "local");

  return (
    <Card className="rounded-2xl border-white/80 bg-white/90 shadow-sm">
      <CardContent className="space-y-6 p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-stone-100">
              <Cloud className="size-5 text-stone-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold tracking-tight">远程存储</h2>
              <p className="text-sm text-stone-500">
                新生成图片会先保存本地，再同步到 WebDAV 或 S3 兼容存储。
              </p>
            </div>
          </div>
          <Badge variant={remote.enabled ? "success" : "secondary"} className="w-fit rounded-md">
            {remote.enabled ? "已启用" : "未启用"}
          </Badge>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
            <Checkbox
              checked={Boolean(remote.enabled)}
              onCheckedChange={(checked) => setRemoteStorageField("enabled", Boolean(checked))}
            />
            启用图片远程存储
          </label>
          <label className="flex items-center gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700">
            <Checkbox
              checked={Boolean(remote.delete_local_after_upload)}
              onCheckedChange={(checked) => setRemoteStorageField("delete_local_after_upload", Boolean(checked))}
            />
            上传成功后删除本地图片
          </label>

          <div className="space-y-2">
            <label className="text-sm text-stone-700">存储类型</label>
            <Select value={provider} onValueChange={(value) => setRemoteStorageField("provider", value)}>
              <SelectTrigger className="h-10 rounded-xl border-stone-200 bg-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">仅本地</SelectItem>
                <SelectItem value="webdav">WebDAV</SelectItem>
                <SelectItem value="s3">S3 兼容</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-stone-700">保存目录</label>
            <Input
              value={String(remote.path_prefix || "")}
              onChange={(event) => setRemoteStorageField("path_prefix", event.target.value)}
              placeholder="images"
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm text-stone-700">公开访问地址</label>
            <Input
              value={String(remote.public_base_url || "")}
              onChange={(event) => setRemoteStorageField("public_base_url", event.target.value)}
              placeholder="https://cdn.example.com"
              className="h-10 rounded-xl border-stone-200 bg-white"
            />
            <p className="text-xs text-stone-500">
              留空时仍会上传远程备份，但前端继续使用本地图片地址。
            </p>
          </div>
        </div>

        {provider === "webdav" ? (
          <div className="grid gap-4 rounded-xl border border-stone-200 bg-stone-50 p-4 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-stone-700">WebDAV 地址</label>
              <Input
                value={String(remote.webdav?.url || "")}
                onChange={(event) => setRemoteStorageNestedField("webdav", "url", event.target.value)}
                placeholder="https://dav.example.com/remote.php/dav/files/user"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">账号</label>
              <Input
                value={String(remote.webdav?.username || "")}
                onChange={(event) => setRemoteStorageNestedField("webdav", "username", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">密码</label>
              <Input
                type="password"
                value={String(remote.webdav?.password || "")}
                onChange={(event) => setRemoteStorageNestedField("webdav", "password", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>
        ) : null}

        {provider === "s3" ? (
          <div className="grid gap-4 rounded-xl border border-stone-200 bg-stone-50 p-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-stone-700">Endpoint</label>
              <Input
                value={String(remote.s3?.endpoint || "")}
                onChange={(event) => setRemoteStorageNestedField("s3", "endpoint", event.target.value)}
                placeholder="https://xxx.r2.cloudflarestorage.com"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">Bucket</label>
              <Input
                value={String(remote.s3?.bucket || "")}
                onChange={(event) => setRemoteStorageNestedField("s3", "bucket", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">Region</label>
              <Input
                value={String(remote.s3?.region || "")}
                onChange={(event) => setRemoteStorageNestedField("s3", "region", event.target.value)}
                placeholder="auto"
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-stone-700">Access Key ID</label>
              <Input
                value={String(remote.s3?.access_key_id || "")}
                onChange={(event) => setRemoteStorageNestedField("s3", "access_key_id", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
            <div className="space-y-2 md:col-span-2">
              <label className="text-sm text-stone-700">Secret Access Key</label>
              <Input
                type="password"
                value={String(remote.s3?.secret_access_key || "")}
                onChange={(event) => setRemoteStorageNestedField("s3", "secret_access_key", event.target.value)}
                className="h-10 rounded-xl border-stone-200 bg-white"
              />
            </div>
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-xl border-stone-200 bg-white px-4 text-stone-700"
            onClick={() => void testRemoteStorage()}
            disabled={isTestingRemoteStorage || provider === "local"}
          >
            {isTestingRemoteStorage ? <LoaderCircle className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            测试连接
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
