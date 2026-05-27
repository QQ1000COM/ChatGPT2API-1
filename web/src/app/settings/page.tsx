"use client";

import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { useAuthGuard } from "@/lib/use-auth-guard";

import { BackupSettingsCard } from "./components/backup-settings-card";
import { CPAPoolDialog } from "./components/cpa-pool-dialog";
import { CPAPoolsCard } from "./components/cpa-pools-card";
import { FloatingSaveBar } from "./components/floating-save-bar";
import { ImportBrowserDialog } from "./components/import-browser-dialog";
import { RemoteStorageCard } from "./components/remote-storage-card";
import { Section } from "./components/section";
import { SettingsHeader } from "./components/settings-header";
import { SettingsTOC, type TOCItem } from "./components/settings-toc";
import {
  AccountSection,
  AIReviewSection,
  ImageSection,
  LogSection,
  NetworkSection,
  SecuritySection,
} from "./components/settings-sections";
import { Sub2APIConnections } from "./components/sub2api-connections";
import { UserKeysCard } from "./components/user-keys-card";
import { useSettingsStore } from "./store";

const SECTIONS: Array<TOCItem & { description: string }> = [
  { id: "account", label: "账号与身份", description: "账号刷新策略、自动维护开关，以及分发给团队的用户密钥。" },
  { id: "network", label: "网络", description: "全局代理，同时影响生图请求和 OpenAI 上游转发。" },
  { id: "images", label: "图片", description: "访问地址、生成超时、并发上限、过期清理和保护策略。" },
  { id: "remote-storage", label: "远程存储", description: "把新生成图片同步到 WebDAV 或 S3 兼容云存储，可配置公开访问地址。" },
  { id: "security", label: "内容安全", description: "敏感词与全局附加指令，把审查放在请求落到生图账号之前。" },
  { id: "ai-review", label: "AI 审核", description: "用独立模型对用户提示词做合规判断，命中即拒绝。" },
  { id: "logs", label: "日志", description: "控制台输出级别，debug 仅排查问题时打开。" },
  { id: "backup", label: "备份", description: "Cloudflare R2 自动备份配置、立即备份与历史备份列表。" },
  { id: "cpa", label: "CPA 号池", description: "外部 CPA 接入，支持远程账号选择性导入到本地号池。" },
  { id: "sub2api", label: "sub2api", description: "把已有的 OpenAI 兼容服务串成 sub2api 多节点上游。" },
];

function SettingsDataController() {
  const didLoadRef = useRef(false);
  const initialize = useSettingsStore((state) => state.initialize);
  const loadPools = useSettingsStore((state) => state.loadPools);
  const loadBackups = useSettingsStore((state) => state.loadBackups);
  const pools = useSettingsStore((state) => state.pools);
  const backupState = useSettingsStore((state) => state.backupState);

  useEffect(() => {
    if (didLoadRef.current) return;
    didLoadRef.current = true;
    void initialize();
  }, [initialize]);

  useEffect(() => {
    const hasRunningJobs = pools.some((pool) => {
      const status = pool.import_job?.status;
      return status === "pending" || status === "running";
    });
    if (!hasRunningJobs) return;
    const timer = window.setInterval(() => {
      void loadPools(true);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadPools, pools]);

  useEffect(() => {
    if (!backupState?.running) return;
    const timer = window.setInterval(() => {
      void loadBackups(true);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [backupState?.running, loadBackups]);

  return null;
}

function SectionBody({ id }: { id: string }) {
  switch (id) {
    case "account":
      return (
        <div className="space-y-6">
          <AccountSection />
          <UserKeysCard />
        </div>
      );
    case "network":
      return <NetworkSection />;
    case "images":
      return <ImageSection />;
    case "remote-storage":
      return <RemoteStorageCard />;
    case "security":
      return <SecuritySection />;
    case "ai-review":
      return <AIReviewSection />;
    case "logs":
      return <LogSection />;
    case "backup":
      return <BackupSettingsCard />;
    case "cpa":
      return <CPAPoolsCard />;
    case "sub2api":
      return <Sub2APIConnections />;
    default:
      return null;
  }
}

function SettingsPageContent() {
  const tocItems: TOCItem[] = SECTIONS.map(({ id, label }) => ({ id, label }));
  return (
    <>
      <SettingsDataController />
      <SettingsHeader />

      <div className="mt-8 flex gap-12 pb-24">
        <main className="min-w-0 flex-1 space-y-12">
          {SECTIONS.map(({ id, label, description }) => (
            <Section key={id} id={id} title={label} description={description}>
              <SectionBody id={id} />
            </Section>
          ))}
        </main>
        <SettingsTOC items={tocItems} />
      </div>

      <CPAPoolDialog />
      <ImportBrowserDialog />
      <FloatingSaveBar />
    </>
  );
}

export default function SettingsPage() {
  const { isCheckingAuth, session } = useAuthGuard(["admin"]);

  if (isCheckingAuth || !session || session.role !== "admin") {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoaderCircle className="size-5 animate-spin text-stone-400" />
      </div>
    );
  }

  return <SettingsPageContent />;
}
