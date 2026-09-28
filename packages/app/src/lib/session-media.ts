const base = import.meta.env?.VITE_API_URL || "";
export interface SessionImage {
    id: string;
    entryId: string;
    filename: string;
    metadata: Record<string, unknown>;
    version: number;
    sizeBytes: number;
    url: string | null;
    thumbnailUrl: string | null;
    deleted: boolean;
}
export interface ManagedSessionImage {
    usage: 'shared' | 'save' | 'unused';
    id: string;
    filename: string;
    sizeBytes: number;
    revision: number;
    status: string;
    thumbnailUrl: string | null;
    width: number;
    height: number;
}
export interface MediaReference {
    id: string;
    sessionId: string | null;
    checkpointId: string | null;
    shareId: string | null;
    entryId: string;
    version: number;
    historical: boolean;
    name: string;
}
export interface MediaDetail {
    id: string;
    filename: string;
    sizeBytes: number;
    revision: number;
    status: string;
    url: string | null;
    references: MediaReference[];
    referenceCount: number;
}
export interface MediaLibrary {
    items: ManagedSessionImage[];
    hasMore: boolean;
    configured: boolean;
    sessions: {
        id: string;
        name: string;
    }[];
    storage: {
        used: number;
        limit: number;
        mediaBytes: number;
        reserved: number;
    };
}
export interface SessionImagePage {
    items: SessionImage[];
    hasMore: boolean;
    uploadsEnabled?: boolean;
    initialized?: boolean;
    document?: {
        value: Record<string, unknown>;
        version: number;
    };
}
export class SessionMediaError extends Error {
    constructor(public code: string) { super(code); }
}
function uploadUuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes=crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
    const hex=[...bytes].map(value=>value.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export async function mediaRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${base}/api/${path}`, { ...init, credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers }, signal: init?.signal ?? AbortSignal.timeout(60000) });
    const body = await response.json();
    if (!response.ok)
        throw new SessionMediaError(body.code ?? body.error ?? "MEDIA_UNAVAILABLE");
    return body.data;
}
export async function listSessionImages(sessionId: string, offset = 0, shareId?: string) {
    const contentLevel = shareId ? (await import("@/hooks/use-content-level")).getContentLevel() : "safe";
    const path = shareId ? `playthroughs/${encodeURIComponent(shareId)}?media=1&contentLevel=${contentLevel}&offset=${offset}` :
        `session-media/session/${encodeURIComponent(sessionId)}?offset=${offset}`;
    return mediaRequest<SessionImagePage>(path);
}
/** Caller retains its original File on failure. Reuse uploadId for network retries. */
export async function uploadSessionImage(sessionId: string, file: Blob, options: {
    entryId?: string;
    filename?: string;
    metadata?: Record<string, unknown>;
    uploadId?: string;
} = {}) {
    if (!(file instanceof Blob) || file.size < 1 || file.size > 16 * 1024 * 1024)
        throw new SessionMediaError("MEDIA_INVALID_SIZE");
    let id = options.uploadId ?? uploadUuid();
    const entryId = options.entryId ?? id;
    const reserve = () => mediaRequest<{
        uploadUrl?: string;
        complete: boolean;
        mediaId?: string;
    }>("session-media/uploads", { method: "POST", body: JSON.stringify({ id, sessionId, entryId, filename: options.filename ?? (file instanceof File ? file.name : "image"), contentType: file.type, size: file.size, metadata: options.metadata ?? {} }) });
    let reservation;
    try {
        reservation = await reserve();
    } catch (error) {
        if (!(error instanceof SessionMediaError) || error.code !== 'MEDIA_UPLOAD_EXPIRED') throw error;
        // Expired PUTs cannot be renewed. Keep the logical entry stable while
        // starting one fresh reservation, so interrupted legacy migration resumes.
        id = uploadUuid();
        reservation = await reserve();
    }
    if (!reservation.complete) {
        const result = await fetch(reservation.uploadUrl!, { method: "PUT", headers: { "Content-Type": file.type }, body: file, credentials: "omit", signal: AbortSignal.timeout(120000) });
        if (!result.ok)
            throw new SessionMediaError("MEDIA_UPLOAD_FAILED");
    }
    return mediaRequest<{
        mediaId: string;
        entryId: string;
    }>(`session-media/uploads/${id}/complete`, { method: "POST" });
}
export function chooseSessionImage(): Promise<File | null> {
    return new Promise(resolve => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/jpeg,image/png,image/webp";
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.oncancel = () => resolve(null);
        input.click();
    });
}
