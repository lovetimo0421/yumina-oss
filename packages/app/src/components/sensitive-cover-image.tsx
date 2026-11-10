import { useLayoutEffect, useRef, useState, type ComponentProps, type MouseEvent } from "react";
import { Eye, EyeOff, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CroppedImage } from "@/lib/cover-crop";
import { cardImageUrl } from "@/lib/asset-url";
import { useSession } from "@/lib/auth-client";
import "./sensitive-cover-image.css";

type Props = ComponentProps<typeof CroppedImage> & {
  conceal: boolean;
  /** Decorative carousel choices cannot contain another interactive control. */
  decorative?: boolean;
  presentation?: "poster" | "hero";
};

export const MEDIA_SETTINGS_HREF = "/app/settings#content-safety/blur-sensitive";

/** Temporary consent for this image only. No account preference is written. */
export function SensitiveCoverImage(props: Props) {
  const viewer = useSession().data?.user.id ?? "guest";
  return <CoverImage key={JSON.stringify([props.src, viewer, props.conceal])} {...props} />;
}

function CoverImage({ conceal, decorative = false, presentation, className, style, ...image }: Props) {
  const { t } = useTranslation("common");
  const [revealed, setRevealed] = useState(false);
  const actionRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const hidden = conceal && !revealed;
  const stop = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
  const toggle = (event: MouseEvent) => {
    stop(event);
    restoreFocus.current = true;
    setRevealed(value => !value);
  };
  useLayoutEffect(() => {
    if (restoreFocus.current) {
      actionRef.current?.focus({ preventScroll: true });
      restoreFocus.current = false;
    }
  }, [revealed]);

  if (!conceal) return <CroppedImage {...image} className={className} style={style} />;

  return <div className={`sensitive-cover ${className ?? ""}`} style={style}
    data-cover-hidden={hidden ? "true" : "false"} data-presentation={presentation}>
    {hidden ? <div className="sensitive-cover-fog" aria-hidden="true">
      <img src={cardImageUrl(image.src, 24, { still: true })} alt="" loading={image.loading} decoding="async" draggable={false} />
      <div className="sensitive-cover-veil" />
    </div> : <CroppedImage {...image} className="absolute inset-0 h-full w-full" />}
    {!decorative && <div className="sensitive-cover-controls">{hidden ? <div className="sensitive-cover-prompt" onClick={stop}>
      <EyeOff className="sensitive-cover-symbol" aria-hidden="true" strokeWidth={1.25} />
      <span className="sensitive-cover-title">{t("sensitiveCover.hidden")}</span>
      <span className="sensitive-cover-description">{t("sensitiveCover.description")}</span>
      <button ref={actionRef} type="button" className="sensitive-cover-show" onClick={toggle}>
        <Eye aria-hidden="true" size={15} /><span>{t("sensitiveCover.show")}</span>
      </button>
      <a href={MEDIA_SETTINGS_HREF} className="sensitive-cover-settings" onClick={event => event.stopPropagation()}>
        <Settings2 aria-hidden="true" size={12} /><span>{t("sensitiveCover.settings")}</span>
      </a>
    </div> : <button ref={actionRef} type="button" className="sensitive-cover-hide" onClick={toggle}>
      <EyeOff size={13} aria-hidden="true" /><span>{t("sensitiveCover.hide")}</span>
    </button>}</div>}
  </div>;
}
