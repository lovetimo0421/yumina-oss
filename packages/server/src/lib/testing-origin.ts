export const TESTING_ORIGINS = [
  "https://yumina-testing.io",
  "https://creator.yumina-testing.io",
];

export const TESTING_ORIGIN = TESTING_ORIGINS[0];
export const TESTING_HOST = "yumina-testing.io";

function hostFromHeader(value: string | undefined | null) {
  return value?.split(",")[0]?.trim().split(":")[0]?.toLowerCase() || "";
}

const TESTING_HOSTS = new Set([
  "yumina-testing.io",
  "creator.yumina-testing.io",
]);

function isTestingHost(host: string) {
  return TESTING_HOSTS.has(host.toLowerCase());
}

export function isTestingRequest(url: string, headers?: Headers) {
  const requestHost = new URL(url).hostname.toLowerCase();
  const host = hostFromHeader(headers?.get("host"));
  const forwardedHost = hostFromHeader(headers?.get("x-forwarded-host"));

  return isTestingHost(requestHost) || isTestingHost(host) || isTestingHost(forwardedHost);
}
