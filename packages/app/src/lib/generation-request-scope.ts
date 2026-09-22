/** A mounted account owns its requests; abandoned responses may never write to another account. */
export class GenerationRequestScope {
  private controllers = new Set<AbortController>();
  private live = true;
  private sequence = 0;

  constructor(private isOwner: () => boolean) {}

  activate() { this.live = true; }
  get current() { return this.live && this.isOwner(); }
  nextVersion() { return ++this.sequence; }

  async request<T>(url: string, init: RequestInit = {}) {
    const controller = new AbortController();
    const version = this.nextVersion();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), init.method && init.method !== "GET" ? 45_000 : 20_000);
    try {
      if (!this.current) throw new DOMException("Request abandoned", "AbortError");
      const response = await fetch(url, { ...init, credentials: "include", signal: controller.signal });
      const data = await response.json().catch(() => ({})) as T;
      if (!this.current || controller.signal.aborted) throw new DOMException("Request abandoned", "AbortError");
      return { response, data, version };
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    }
  }

  dispose() {
    this.live = false;
    this.controllers.forEach(controller => controller.abort());
    this.controllers.clear();
  }
}
