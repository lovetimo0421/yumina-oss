import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds } from "../db/schema.js";
import type { ResolvedProvider } from "./resolve-provider.js";
import type { GenerateParams } from "./llm/types.js";

export const MEMORY_QA_TAG = "qa-memory-warning-20260915";
export type MemoryQaScenario = "truncated" | "oversized" | "recovered";
export function memoryQaEnvironmentEnabled(): boolean {
  // Trust deployment configuration, never a client-controlled Host header.
  return process.env.RAILWAY_ENVIRONMENT_NAME === "testing";
}
export async function canRunMemoryQa(sessionId: string, userId: string): Promise<boolean> {
  if (!memoryQaEnvironmentEnabled()) return false;
  const [row] = await db.select({tags: worlds.tags, visibility: worlds.visibility, published: worlds.isPublished, creatorId: worlds.creatorId})
    .from(playSessions).innerJoin(worlds, eq(playSessions.worldId, worlds.id))
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, userId))).limit(1);
  return !!row && row.creatorId === userId && row.visibility === "private" && !row.published && Array.isArray(row.tags) && row.tags.includes(MEMORY_QA_TAG);
}

export function createMemoryQaProvider(scenario: MemoryQaScenario, calls: GenerateParams[] = []): ResolvedProvider {
  const complete = "Core facts:\n- 林澄持有青铜钥匙，江珩保管蓝色药箱。\nActive goals:\n- 两人须在日落前把药箱送到南堤医馆。\nCurrent risks:\n- 北桥已经封闭，必须改走东岸。";
  const oversized = Array.from({length: 240}, (_, i) => `- 档案 ${i + 1}：${createHash("sha256").update(String(i)).digest("hex")}，尚待核验。`).join("\n");
  return {
    isByok: true, apiKeyTier: "byok", providerName: "custom",
    provider: {
      async *generateStream(params) {
        calls.push(params);
        const recovered = scenario === "recovered" && calls.length > 1;
        yield {type: "text" as const, content: recovered ? complete : scenario === "oversized" ? oversized : `${complete}\n- 下一步需要在`};
        // No upstream call, fabricated token usage, or credit debit.
        yield {type: "done" as const, content: "", stopReason: recovered || scenario === "oversized" ? "stop" : "max_tokens"};
      },
      async listModels() { return []; },
    },
  };
}

export function memoryQaPage(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error("Invalid session ID");
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>记忆截断测试</title>
<style>body{background:#141719;color:#eee;font:16px/1.7 system-ui;max-width:760px;margin:40px auto;padding:20px}button,a{color:#efc779}button{background:#292723;border:1px solid #77613c;border-radius:10px;padding:12px 16px;margin:6px;cursor:pointer}button:disabled{opacity:.5}pre{white-space:pre-wrap;background:#202528;padding:20px;border-radius:12px}#warning{color:#efc779}</style>
<h1>记忆截断测试</h1><p>这是可重复的模拟响应测试，不调用真实 AI、不扣蘑菇。每个按钮会重新生成并替换这个专用测试会话的记忆，走实际重试和保存流程。</p>
<button data-case="truncated">① 两次都截断 → 保留并警告</button><button data-case="oversized">② 两次都超长 → 保留上限内内容</button><button data-case="recovered">③ 第二次完整 → 清除警告</button>
<p><a href="/app/chat/${sessionId}" target="_blank" rel="noopener">打开测试会话：记忆与摘要 → 记忆</a></p><p id="status">选一个场景开始；测试后可刷新会话查看持久保存结果。</p><p id="warning"></p><pre id="result"></pre>
<script>for(const button of document.querySelectorAll('button'))button.onclick=async()=>{const buttons=[...document.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);document.getElementById('status').textContent='运行中…';try{const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario:button.dataset.case})});const body=await response.json();if(!response.ok)throw Error(body.error||'测试失败');document.getElementById('status').textContent='已保存。生成 '+body.calls.length+' 次；实际输出上限：'+body.calls.map(c=>c.maxTokens).join(' / ')+' token。';document.getElementById('warning').textContent=body.data.memory.warning?'记忆摘要被截断，可能遗漏信息。已保存内容正常使用。':'完整记忆已保存，无截断警告。';document.getElementById('result').textContent=body.data.memory.text;}catch(error){document.getElementById('status').textContent=error.message;}finally{buttons.forEach(b=>b.disabled=false);}};</script></html>`;
}
