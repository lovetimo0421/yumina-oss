/**
 * Build the public landing-page URL used by account-deletion emails.
 *
 * The origin is the deployment's configured canonical APP_URL, never an
 * attacker-controlled Host header. The token stays in the fragment so it is
 * not sent to the server, reverse proxy, analytics, or referrer targets during
 * the initial page load.
 */
export function buildAccountDeletionConfirmationUrl(
  appUrl: string,
  token: string,
): string {
  const appOrigin = new URL(appUrl).origin;
  const confirmationUrl = new URL("/delete-account", appOrigin);
  confirmationUrl.hash = new URLSearchParams({ token }).toString();
  return confirmationUrl.toString();
}
