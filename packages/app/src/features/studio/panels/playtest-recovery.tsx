import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@/stores/chat";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { resolveModelSourceKey, useModelsStore } from "@/stores/models";
import { useUserProfileStore } from "@/stores/user-profile";
import { ModelBrowser } from "@/features/chat/model-browser";
import { resolvePlaytestIssue, type PlaytestIssue } from "./playtest-recovery-state";

export function PlaytestRecovery({ sessionId }: { sessionId: string }) {
  const selectedModel = useConfigStore(s => s.selectedModel);
  const mixMode = useConfigStore(s => s.mixMode);
  const pool = useConfigStore(s => s.modelPool);
  const provider = useCreditStore(s => s.provider);
  const creditFetched = useCreditStore(s => s.lastFetched);
  const preferences = useUserProfileStore(s => s.profile?.preferences);
  const source = useModelsStore(s => s.lastSourceKey);
  const models = useModelsStore(s => s.models);
  const loadingModels = useModelsStore(s => s.loading);
  const session = useChatStore(s => s.session);
  const streaming = useChatStore(s => s.isStreaming);
  const failure = useChatStore(s => s.lastSendFailure);
  const error = useChatStore(s => s.error);
  const [modelOpen, setModelOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<"done" | "failed" | null>(null);
  const checkToken = useRef(0);
  const expectedSource = resolveModelSourceKey(provider, creditFetched, preferences ?? null);
  const issue = resolvePlaytestIssue({ sessionId, activeSessionId: session?.id, streaming,
    hasModel: !!selectedModel.trim() || (mixMode && pool.length > 1),
    privateCatalogEmpty: expectedSource.startsWith("private:") && source === expectedSource && !loadingModels && models.length === 0,
    failure, error });

  useEffect(() => {
    setChecked(null); setChecking(false); checkToken.current++;
    return () => { checkToken.current++; };
  }, [sessionId, failure, issue]);

  const checkConversation = async () => {
    const token = ++checkToken.current;
    const before = new Set(useChatStore.getState().messages.filter(m => m.role === "assistant").map(m => m.id));
    setChecking(true); setChecked(null);
    // A read only: uncertain network failures may already have a billed reply.
    let ok = false;
    try { ok = await useChatStore.getState().refreshMessages(); } catch { /* Keep the recovery controls available. */ }
    if (token !== checkToken.current || useChatStore.getState().session?.id !== sessionId) return;
    setChecking(false); setChecked(ok ? "done" : "failed");
    if (ok && useChatStore.getState().messages.some(m => m.role === "assistant" && m.content.trim() && !before.has(m.id))) {
      useChatStore.getState().clearError();
    }
  };

  return <>
    {issue && <PlaytestRecoveryNotice issue={issue} checking={checking} checked={checked}
      onChooseModel={() => setModelOpen(true)} onCheck={() => void checkConversation()} />}
    {modelOpen && <ModelBrowser open onClose={() => setModelOpen(false)} selectedModel={selectedModel} onSelect={id => {
      useConfigStore.getState().setConfig("selectedModel", id);
      useConfigStore.getState().setConfig("mixMode", false);
      useModelsStore.getState().addToRecent(id);
      // Selecting is not a paid retry. The author sends again from the composer.
      if (issue !== "connection") useChatStore.getState().clearError();
      setModelOpen(false);
    }} />}
  </>;
}

export function PlaytestRecoveryNotice({ issue, onChooseModel, onCheck, checking, checked }: {
  issue: PlaytestIssue; onChooseModel: () => void; onCheck: () => void;
  checking: boolean; checked: "done" | "failed" | null;
}) {
  const { t } = useTranslation("learning");
  const checkable = ["request", "connection", "busy"].includes(issue);
  const className = "rounded-lg border border-primary/30 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10 disabled:opacity-50";
  return <div role="alert" data-playtest-recovery={issue} className="shrink-0 border-b border-primary/25 bg-primary/5 px-3 py-2.5 text-foreground">
    <p className="text-xs font-medium">{t(`recovery.${issue}.title`)}</p>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(`recovery.${issue}.body`)}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {issue !== "access" && <button type="button" className={className} onClick={onChooseModel}>{t("recovery.chooseModel")}</button>}
      {(issue === "credits" || issue === "promptCost") && <a className={className} href="/app/plans" target="_blank" rel="noopener noreferrer">{t("recovery.viewCredits")}</a>}
      {(issue === "provider" || issue === "access") && <a className={className} href={issue === "provider" ? "/app/settings#ai-config" : "/app/settings"} target="_blank" rel="noopener noreferrer">{t("recovery.settings")}</a>}
      {checkable && <button type="button" className={className} disabled={checking} onClick={onCheck}>{t(checking ? "recovery.checking" : "recovery.checkConversation")}</button>}
    </div>
    {checked && <p role="status" className="mt-1.5 text-xs text-muted-foreground">{t(checked === "done" ? "recovery.checked" : "recovery.checkFailed")}</p>}
  </div>;
}
