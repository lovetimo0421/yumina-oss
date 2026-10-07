import { toast } from "sonner";

/**
 * 时刻: a moment the card unlocked (a memory card, a CG, an ending) shown as
 * a card with its picture, the way 24 published cards drew it by hand.
 */
export function showMoment({ title, text, image }: { title: string; text: string; image?: string }): void {
  if (!title && !text) return;
  toast.custom(
    (id) => (
      <button
        type="button"
        onClick={() => toast.dismiss(id)}
        className="flex w-[320px] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-amber-300/40 bg-[#17151d] text-left shadow-[0_18px_60px_rgba(0,0,0,0.55)]"
        data-moment=""
      >
        {image && <img src={image} alt="" className="max-h-48 w-full object-cover" draggable={false} />}
        <span className="flex flex-col gap-1 px-4 py-3">
          {title && <span className="text-sm font-bold text-amber-100">{title}</span>}
          {text && <span className="text-[13px] leading-relaxed text-foreground/80">{text}</span>}
        </span>
      </button>
    ),
    { duration: 7000 },
  );
}
