import { uploadAssetWithPresignedUrl } from "@/lib/asset-upload";
import type { Message, SessionData } from "@/stores/chat";
import type { UserAsset } from "@/stores/user-assets";

const apiBase = import.meta.env.VITE_API_URL || "";
const OUTPUT_CHAT_ASSET_FOLDER_NAME = "output chat";

function sanitizeFilename(name: string): string {
  const cleaned = Array.from(name.trim() || "Chat")
    .map((char) => {
      const code = char.charCodeAt(0);
      if (code < 32 || /[<>:"/\\|?*]/.test(char)) return "_";
      return char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "Chat";
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatTimestampForFilename(date: Date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + ` ${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function buildTranscriptMessages(messages: Message[]) {
  return messages
    .filter((msg) => msg.role !== "system")
    .map((msg) => {
      const speaker = msg.role === "user" ? "User" : "Assistant";
      return `${speaker}: ${msg.content}`;
    });
}

export function buildSessionTextExport(session: SessionData, messages: Message[]) {
  const now = new Date();
  const worldName = session.world?.name ?? "Chat";
  const sessionName = session.name?.trim() || null;
  const transcript = buildTranscriptMessages(messages);

  const lines: string[] = [
    `World: ${worldName}`,
    `Session ID: ${session.id}`,
    `Exported At: ${now.toISOString()}`,
  ];

  if (sessionName) {
    lines.splice(1, 0, `Session: ${sessionName}`);
  }

  if (transcript.length > 0) {
    lines.push("", ...transcript);
  }

  const filename = `${sanitizeFilename(worldName)} - Log ${formatTimestampForFilename(now)}.txt`;

  return {
    filename,
    content: lines.join("\n\n"),
    communityTitle: `Session log: ${worldName}`,
  };
}

export async function uploadSessionTextAsset(session: SessionData, messages: Message[]) {
  const { filename, content, communityTitle } = buildSessionTextExport(session, messages);
  const file = new File([content], filename, { type: "text/plain" });

  const asset = await uploadAssetWithPresignedUrl<UserAsset>({
    file,
    preferredType: "txt",
    prepareUrl: `${apiBase}/api/user-assets/upload-url`,
    registerUrl: `${apiBase}/api/user-assets`,
    prepareCredentials: "include",
    registerCredentials: "include",
    registerBody: ({ key, resolvedType, contentType }) => ({
      key,
      filename: file.name,
      type: resolvedType,
      mimeType: contentType,
      sizeBytes: file.size,
      folderName: OUTPUT_CHAT_ASSET_FOLDER_NAME,
    }),
  });

  return {
    asset,
    filename,
    content,
    communityTitle,
  };
}
