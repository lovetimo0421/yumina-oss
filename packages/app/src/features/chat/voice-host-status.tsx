import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { VoiceEvent, VoiceFinishResult } from '../../../sandbox/voice-types';

/** Native chrome owns operational messages. Provider bodies never enter it. */
export function VoiceHostStatus({ event, stop, finish }: {
  event: Extract<VoiceEvent, { type: 'status' }> | null;
  stop(): void;
  finish(): Promise<VoiceFinishResult>;
}) {
  const { t } = useTranslation('chat');
  const [busy, setBusy] = useState(false);
  if (!event?.phase) return null;
  const terminal = event.code === 'VOICE_BALANCE_FINISHED' || event.code === 'VOICE_BALANCE_NOT-STARTED';
  const key = event.status === 'error' ? 'error' : event.code === 'VOICE_BALANCE_FINISHED' ? 'finished'
    : event.code === 'VOICE_BALANCE_PENDING' ? 'pending' : event.code === 'VOICE_BALANCE_INCOMPLETE' ? 'incomplete'
      : event.code === 'VOICE_BALANCE_UNAVAILABLE' ? 'unavailable' : event.code === 'VOICE_BALANCE_NOT-STARTED' ? 'notStarted'
        : event.phase === 'cleanup' ? 'stopped' : event.phase;
  // Leave the world's top-corner pause and navigation controls reachable,
  // including when a recovery notice must remain visible after voice stops.
  return <div className="absolute left-1/2 top-[calc(64px+env(safe-area-inset-top))] z-20 w-[calc(100%-1.5rem)] max-w-sm -translate-x-1/2 rounded-xl border border-border bg-background/95 p-3 text-xs text-foreground shadow-md">
    <p role="status" aria-live="polite">{event.code === 'VOICE_INPUT_PAUSED' || event.code === 'VOICE_INPUT_RESUMED' ? event.message : t(`nativeVoice.${key}`)}</p>
    <div className="mt-2 flex justify-end gap-2">
      {(event.status === 'connecting' || event.status === 'connected') && <button type="button" onClick={stop} className="min-h-[44px] rounded-md border border-border px-3 py-2">{t('nativeVoice.stop')}</button>}
      {event.phase === 'cleanup' && !terminal && <button type="button" disabled={busy} onClick={() => {
        setBusy(true); void finish().catch(() => {}).finally(() => setBusy(false));
      }} className="min-h-[44px] rounded-md border border-border px-3 py-2 disabled:opacity-50">{t('nativeVoice.retry')}</button>}
    </div>
  </div>;
}
