import { createFileRoute, redirect } from "@tanstack/react-router";
import { OAuthConsentPage } from "@/features/auth/oauth-consent-page";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/oauth/consent")({
  // The authorization server only sends signed-in creators here; anyone else
  // signs in first and comes back with the same request.
  beforeLoad: async ({ location }) => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ href: `/login${location.searchStr}` });
  },
  component: OAuthConsentPage,
});
