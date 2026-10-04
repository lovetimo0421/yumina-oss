import {
  getElAudioLevel,
  getElVolume,
  isElAudioOutputRunning,
} from "./media-volume";
/** One owned parent voice element. Frames contain no audio bytes or text.
 * `audible` means the browser is actively outputting unmuted audio; it cannot
 * establish hardware speaker volume. Undefined audioLevel means unmeasurable.
 * Legacy TTS button state/progress remains a separate, unchanged contract. */
export interface VoicePlaybackFrame {
  key: string;
  generation: number;
  audible: boolean;
  audioLevel?: number;
  currentTime: number;
  duration?: number;
}
export function createVoicePlaybackMonitor(
  audio: HTMLMediaElement,
  key: string,
  generation: number,
  emit: (frame: VoicePlaybackFrame) => void,
) {
  let closed = false;
  let playing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stopTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  function refresh() {
    if (closed) return;
    const active =
      playing &&
      !audio.paused &&
      !audio.ended &&
      !audio.muted &&
      getElVolume(audio) > 0;
    const level = active ? getElAudioLevel(audio) : 0;
    const audible = active && isElAudioOutputRunning(audio);
    emit({
      key,
      generation,
      audible,
      audioLevel: audible ? level : 0,
      currentTime: Number.isFinite(audio.currentTime)
        ? Math.max(0, audio.currentTime)
        : 0,
      ...(Number.isFinite(audio.duration) && audio.duration > 0
        ? { duration: audio.duration }
        : {}),
    });
  }
  const onPlaying = () => {
    if (closed) return;
    playing = true;
    refresh();
    stopTimer();
    timer = setInterval(refresh, 66);
  };
  const onSilence = () => {
    playing = false;
    stopTimer();
    refresh();
  };
  const quietEvents = [
    "pause",
    "waiting",
    "emptied",
    "ended",
    "error",
  ];
  audio.addEventListener("playing", onPlaying);
  audio.addEventListener("volumechange", refresh);
  for (const event of quietEvents) audio.addEventListener(event, onSilence);
  // No play() promise or synthesis response is evidence of audible output.
  refresh();
  return {
    refresh,
    dispose() {
      if (closed) return;
      onSilence();
      closed = true;
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("volumechange", refresh);
      for (const event of quietEvents)
        audio.removeEventListener(event, onSilence);
    },
  };
}
