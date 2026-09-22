/** Isolated preview using production components. No API or account writes. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ChatCanvas } from "../sandbox/chat/chat-canvas";
import { YuminaContext, useYumina, COMPOSER_DRAFT_EVENT } from "../sandbox/sandbox-context";
import { ModelBrowser } from "@/features/chat/model-browser";
import { useModelsStore } from "@/stores/models";
import { useCreditStore } from "@/stores/credits";
import { PLAY_MODELS, type ChatImageInput } from "@yumina/shared";
import type { SandboxMessage } from "../sandbox/chat/types";
import i18n from "@/lib/i18n";
import "./vision.css";

void i18n.changeLanguage("zh");
const catalog = PLAY_MODELS.map(m => ({ ...m, provider: m.id.split("/")[0]!, contextLength: m.contextWindow ?? 0, isCurated: true }));
useModelsStore.setState({ models: catalog, curated: catalog, loading: false, lastFetched: Date.now(), lastSourceKey: "official", fetchModels: async () => {} });
useCreditStore.setState({ plan: "ultra", balance: 8420, provider: "official", lastFetched: Date.now(), fetchCredits: async () => {}, forceFetchCredits: async () => {} });
const initial: SandboxMessage[] = [
  { id: "preview-1", sessionId: "preview", role: "assistant", content: "雨停了。你走进街角的旧书店，店主抬头看向你。\n\n“想找什么？如果带了照片，也可以给我看看。”", createdAt: new Date().toISOString() },
];

function Preview() {
  const base = useYumina();
  const [selected, setSelected] = useState("google/gemini-2.5-flash");
  const [picker, setPicker] = useState(false);
  const [messages, setMessages] = useState(initial);
  const [notice, setNotice] = useState("");
  const [mobile, setMobile] = useState(false);
  const demoNotice = (label: string) => { setNotice(`${label}：此处只展示界面，不修改真实存档。`); };
  const send = (text: string, attachments: ChatImageInput[] = []) => setMessages(current => [...current, {
    id: crypto.randomUUID(), sessionId: "preview", role: "user", content: text,
    attachments: attachments.map(a => ({ type: "image", mimeType: a.mimeType, name: a.name, url: `data:${a.mimeType};base64,${a.data}` })), createdAt: new Date().toISOString(),
  }]);
  const api = { ...base, readOnly: false, composerSendKey: "enter" as const, language: "zh", sessionId: "preview", worldName: "街角的旧书店", user: { name: "你", avatar: null },
    messages, selectedModel: selected, userPlan: "ultra", preferredProvider: "official" as const, balance: 8420,
    getModels: async () => ({ models: catalog, pinnedModels: [], recentlyUsed: [] }), setModel: setSelected,
    openModelPicker: () => setPicker(true), sendMessage: send,
    openPersonaManager: () => demoNotice("人设"), openSessionManager: () => demoNotice("存档管理"),
    sharePlaythrough: () => demoNotice("分享对话"), continueLastMessage: () => demoNotice("继续"),
    restartChat: () => setMessages(initial),
    getBranchContext: async () => ({ current: { id: "preview", name: "当前存档", parentSessionId: null, branchedFromMessageId: null, messageCount: messages.length, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, parent: null, siblings: [], children: [] }),
  };
  async function loadSample() {
    const blob = await (await fetch("/hero-tang-sect.jpg")).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "示例图片.jpg", { type: "image/jpeg" }));
    document.querySelector("textarea")?.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
    window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: { text: "帮我看看这张图片里有什么。", focus: false } }));
  }
  return <YuminaContext.Provider value={api}>
    <div className="preview-tools"><span>本地界面预览 · 示例会话</span><div>
      <button onClick={() => void loadSample()}>载入示例图片</button>
      <button onClick={() => setPicker(true)}>查看模型列表</button>
      <button onClick={() => setMobile(v => !v)}>{mobile ? "桌面宽度" : "手机宽度"}</button>
    </div></div>
    <main className={`preview-frame ${mobile ? "preview-phone" : ""}`}>
      <header className="preview-world"><div><span>YUMINA</span><h1>街角的旧书店</h1></div><span>当前存档</span></header>
      <div className="preview-canvas play-page-root"><ChatCanvas /></div>
      <p className="preview-note">可点击 ＋ 查看原有功能，也可以直接在输入框粘贴图片。</p>
    </main>
    {notice && <button className="preview-notice" onClick={() => setNotice("")}>{notice}</button>}
    <ModelBrowser open={picker} onClose={() => setPicker(false)} selectedModel={selected} onSelect={id => { setSelected(id); setPicker(false); }} />
  </YuminaContext.Provider>;
}
const route = createRootRoute({ component: Preview });
const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
