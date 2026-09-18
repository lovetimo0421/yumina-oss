import { useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from "react";

/**
 * Cloudflare Turnstile invisible widget.
 *
 * Renders an invisible CAPTCHA challenge and calls `onToken` with the
 * verification token when ready. The parent form should include this token as
 * `cf-turnstile-response` in the request body.
 *
 * Turnstile tokens are SINGLE-USE: once the server verifies one, reusing it
 * fails. After every form submit, call the imperative `reset()` (and clear the
 * stored token) so a retry gets a fresh token instead of re-sending a spent
 * one — otherwise a user who mistypes their password once is blocked on the
 * retry with a bogus "CAPTCHA verification failed".
 *
 * If VITE_TURNSTILE_SITE_KEY is not set, renders nothing (dev mode).
 */

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

export interface TurnstileHandle {
  /** Discard the current single-use token and request a fresh one. */
  reset: () => void;
}

interface TurnstileProps {
  onToken: (token: string) => void;
  onError?: () => void;
}

export const Turnstile = forwardRef<TurnstileHandle, TurnstileProps>(function Turnstile(
  { onToken, onError },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const scriptLoaded = useRef(false);

  const renderWidget = useCallback(() => {
    if (!containerRef.current || !SITE_KEY) return;
    if (widgetIdRef.current !== null) return;

    const turnstile = (window as any).turnstile;
    if (!turnstile) return;

    // NOTE: no `size` param. "invisible" was never a valid size (valid:
    // normal/flexible/compact) — invisibility comes from the sitekey's widget
    // type in the Cloudflare dashboard. Passing it worked silently until
    // ~2026-06-19, when Turnstile's api.js added validation and started
    // throwing TurnstileError on every auth page load (~1.5k errors/14d).
    widgetIdRef.current = turnstile.render(containerRef.current, {
      sitekey: SITE_KEY,
      callback: (token: string) => onToken(token),
      "error-callback": () => onError?.(),
      "expired-callback": () => {
        // Auto-refresh on expiry
        if (widgetIdRef.current !== null) {
          turnstile.reset(widgetIdRef.current);
        }
      },
    });
  }, [onToken, onError]);

  // Let the parent request a fresh token after a submit (tokens are single-use).
  useImperativeHandle(
    ref,
    () => ({
      reset() {
        const turnstile = (window as any).turnstile;
        if (widgetIdRef.current !== null && turnstile) {
          turnstile.reset(widgetIdRef.current);
        }
      },
    }),
    [],
  );

  useEffect(() => {
    if (!SITE_KEY) return;

    // If the Turnstile script is already loaded, render immediately
    if ((window as any).turnstile) {
      renderWidget();
      return;
    }

    // Load the Turnstile script once
    if (!scriptLoaded.current) {
      scriptLoaded.current = true;
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => renderWidget();
      document.head.appendChild(script);
    }

    return () => {
      if (widgetIdRef.current !== null && (window as any).turnstile) {
        (window as any).turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [renderWidget]);

  if (!SITE_KEY) return null;

  return <div ref={containerRef} />;
});
