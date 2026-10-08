import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

import type { VoiceConfig } from "./voice-controller";
import { useTranslation } from 'react-i18next';

export interface VoiceConsentRequest { config: VoiceConfig; accept(): void; decline(): void }

export function VoiceFundingNotice({ funding, reservationCredits }: { funding: VoiceConfig["funding"] | undefined; reservationCredits?: number }) {
  const { t } = useTranslation('chat');
  const amount = reservationCredits?.toLocaleString(undefined, { maximumFractionDigits: 1 }) ?? '—';
  if (funding === 'balance') return <p className="text-sm text-foreground">{t('nativeVoice.funding', { amount, defaultValue: `Paid from your Yumina balance. ${amount} Mushies is a temporary reservation; the charge is based on measured usage. Unused reserved balance is released after accounting completes.` })}</p>;
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
  const { t } = useTranslation('chat');
  const balance = request?.config.funding === 'balance';
  return <Dialog open={!!request} onOpenChange={open => { if (!open) request?.decline(); }}>
    <DialogContent className="max-w-md">
      <DialogTitle>{balance ? t('nativeVoice.title', {defaultValue:'Enable live voice'}) : 'Enable microphone'}</DialogTitle>
      <DialogDescription>
        {balance ? t('nativeVoice.description', {defaultValue:'Speak naturally and interrupt replies. Your camera stays off.'}) : 'Speak naturally and interrupt replies. Your camera stays off.'}
      </DialogDescription>
      <p className="text-sm text-foreground">{balance ? t('nativeVoice.permissionNotice', {defaultValue:'Your browser may ask you to allow microphone access next.'}) : 'Your browser may ask you to allow microphone access next.'}</p>
      <p className="text-sm text-muted-foreground">
        {balance ? t('nativeVoice.privacy', {defaultValue:'OpenAI receives your microphone audio and the world’s conversation context. Transcripts may be saved in the story.'}) : 'OpenAI receives your microphone audio and the world’s conversation context. Transcripts may be saved in the story.'}
        {request?.config.avatarRequested && " Replies also go to LiveAvatar to animate the telescreen."}
      </p>
      <VoiceFundingNotice funding={request?.config.funding} reservationCredits={request?.config.reservationCredits} />
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">{balance ? t('nativeVoice.disconnectTitle', {defaultValue:'When does the microphone disconnect?'}) : 'When does the microphone disconnect?'}</summary>
        <p className="mt-2">{balance ? t('nativeVoice.disconnect', {defaultValue:'You can stop at any time. Leaving this session, hiding this tab, or reaching five minutes ends the call. Voice is optional.'}) : 'You can stop at any time. Leaving this session, hiding this tab, or reaching five minutes ends the call. Voice is optional.'}</p>
      </details>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => request?.decline()} className="rounded-md border border-border px-4 py-2 text-sm">{balance ? t('nativeVoice.decline', {defaultValue:'Not now'}) : 'Not now'}</button>
        <button type="button" onClick={() => request?.accept()} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">{balance ? t('nativeVoice.accept', {defaultValue:'Enable microphone'}) : 'Enable microphone'}</button>
      </div>
    </DialogContent>
  </Dialog>;
}
