import { SoundPicker } from "@/features/editor/components/sound-picker";

/**
 * A voice for a character, or for the narrator: the card's one sound window
 * (features/editor/components/sound-picker.tsx), opened on voices.
 */
export function VoicePickerPopover({ title, value, onChange, onClose, inputMode, onInputModeChange }: {
  title: string;
  value?: string;
  onChange: (voice: string | undefined) => void;
  onClose: () => void;
  /** Card-wide only (the narrator's window): what the player's voice input does on release. */
  inputMode?: "confirm" | "auto";
  onInputModeChange?: (mode: "confirm" | "auto") => void;
}) {
  return <SoundPicker kind="voice" title={title} value={value} onChange={onChange} onClose={onClose} inputMode={inputMode} onInputModeChange={onInputModeChange} />;
}
