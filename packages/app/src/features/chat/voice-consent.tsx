import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

import type { VoiceConfig } from "./voice-controller";

export interface VoiceConsentRequest { config: VoiceConfig; accept(): void; decline(): void }

export function VoiceFundingNotice({ funding }: { funding: VoiceConfig["funding"] | undefined }) {
  return <p className="text-sm text-foreground">
    {funding === "private-pilot"
      ? "Private test call paid by Yumina · no API key or Yumina credits needed."
      : funding === "testing"
        ? "Testing call included · no API key or Yumina credits needed."
        : "Billed to your saved OpenAI API key. Yumina credits are not used."}
  </p>;
}

/** Trusted host chrome: a world can request voice but cannot grant microphone consent. */
export function VoiceConsent({ request }: { request: VoiceConsentRequest | null }) {
  return <Dialog open={!!request} onOpenChange={open => { if (!open) request?.decline(); }}>
    <DialogContent className="max-w-md">
      <DialogTitle>Enable microphone</DialogTitle>
      <DialogDescription>
        Speak naturally and interrupt replies. Your camera stays off.
      </DialogDescription>
      <p className="text-sm text-foreground">Your browser may ask you to allow microphone access next.</p>
      <p className="text-sm text-muted-foreground">
        OpenAI receives your microphone audio and the world’s conversation context. Transcripts may be saved in the story.
        {request?.config.avatarRequested && " Replies also go to LiveAvatar to animate the telescreen."}
      </p>
      <VoiceFundingNotice funding={request?.config.funding} />
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">When does the microphone disconnect?</summary>
        <p className="mt-2">You can stop at any time. Leaving this session, hiding this tab, or reaching five minutes ends the call. Voice is optional.</p>
      </details>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => request?.decline()} className="rounded-md border border-border px-4 py-2 text-sm">Not now</button>
        <button type="button" onClick={() => request?.accept()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Enable microphone</button>
      </div>
    </DialogContent>
  </Dialog>;
}
