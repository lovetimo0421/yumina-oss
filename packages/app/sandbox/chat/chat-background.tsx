import type { ResolvedBackground } from "@yumina/engine";

/**
 * The picture behind the chat.
 *
 * Three things about this component are load-bearing, and all three are
 * performance decisions rather than visual ones:
 *
 *  1. It is a SIBLING of the transcript, never an ancestor and never a
 *     `backdrop-filter` over it. A blur that reads the layer beneath it makes
 *     every scroll frame re-composite the whole message list — which is
 *     exactly the shape of the lag 53 published custom-UI cards already have.
 *     Blurring our own `<img>` costs one paint, at mount.
 *  2. `pointer-events: none` so it never steals a tap from the transcript.
 *  3. The blurred image is scaled up past its own edges. A Gaussian blur
 *     samples outside the source, so an un-scaled blurred image feathers to
 *     transparent at all four borders and shows the page behind it.
 *
 * It renders nothing at all when there is no background, so a card that never
 * set one pays no DOM for this.
 */
export function ChatBackground({ background }: { background: ResolvedBackground | null }) {
  if (!background?.url) return null;

  const objectPosition =
    background.position === "top" ? "50% 0%"
    : background.position === "bottom" ? "50% 100%"
    : "50% 50%";

  // Blur eats into the edges; grow the picture by roughly twice the radius on
  // each side so the crop still covers the box.
  const overscan = 1 + Math.min(0.3, (background.blur * 2) / 100);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <img
        src={background.url}
        alt=""
        decoding="async"
        // The background is the one image on screen that must not delay the
        // first paint of the text it sits behind.
        loading="lazy"
        draggable={false}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition,
          filter: background.blur > 0 ? `blur(${background.blur}px)` : undefined,
          transform: background.blur > 0 ? `scale(${overscan})` : undefined,
          // The picture's own alpha, so what shows through is the card's
          // background rather than black. `dim` is the black; this is not.
          opacity: background.opacity,
          // A background that pops in mid-sentence is worse than one that
          // fades; the transition is on the layer, not on every message.
          transition: "opacity 220ms ease",
        }}
      />
      {background.dim > 0 && (
        <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${background.dim})` }} />
      )}
    </div>
  );
}
