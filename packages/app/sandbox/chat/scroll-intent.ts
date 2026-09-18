/** A scroll event is an observation, not evidence of reader intent. */
export function isScrollIntent(event: Event): boolean {
  if (event.type === "wheel") return (event as WheelEvent).deltaY !== 0 || (event as WheelEvent).deltaX !== 0;
  if (event.type === "touchmove") return true;
  if (event.type === "keydown") {
    const key = event as KeyboardEvent;
    const target = event.target as Element | null;
    return !key.ctrlKey && !key.metaKey && !key.altKey &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(key.key) &&
      !target?.closest?.("input,textarea,select,[contenteditable=true]");
  }
  if (event.type === "pointerdown") {
    const target = event.target as HTMLElement | null;
    if (!target?.getBoundingClientRect) return false;
    const pointer = event as PointerEvent;
    const rect = target.getBoundingClientRect();
    // Native scrollbar drag, not a tap on the content or a composer button.
    return pointer.pointerType === "mouse" && target.offsetWidth > target.clientWidth &&
      pointer.clientX >= rect.right - (target.offsetWidth - target.clientWidth);
  }
  return false;
}
