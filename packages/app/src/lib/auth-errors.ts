/**
 * Maps known Better Auth error messages to i18n translation keys.
 * Better Auth returns raw English error strings — this maps them to
 * user-friendly, localized messages in the "auth" namespace.
 */
const AUTH_ERROR_MAP: Record<string, string> = {
  // Email/password sign-in
  "User already exists": "errors.userAlreadyExists",
  "Invalid email or password": "errors.invalidCredentials",
  "Invalid email": "errors.invalidEmail",
  "Invalid password": "errors.invalidPassword",
  "Password is too short": "errors.passwordTooShort",
  "Password is too long": "errors.passwordTooLong",
  "Email not verified": "errors.emailNotVerified",
  "Failed to create user": "errors.failedToCreateUser",
  // Additional Better Auth error strings
  "Credential account not found": "errors.invalidCredentials",
  "User not found": "errors.invalidCredentials",
  "Password not found": "errors.invalidCredentials",
  "User email not found": "errors.invalidCredentials",
  "Failed to create session": "errors.generic",
  "Email and password is not enabled": "errors.generic",
  // Username plugin
  "Invalid username or password": "errors.invalidCredentials",
  "Username is already taken. Please try another.": "errors.usernameTaken",
  "Username is too short": "errors.usernameTooShort",
  "Username is too long": "errors.usernameTooLong",
  "Username is invalid": "errors.usernameInvalid",
  "Display username is invalid": "errors.usernameInvalid",
  // Rate limiting / CAPTCHA
  "CAPTCHA verification required": "errors.captchaFailed",
  "CAPTCHA verification failed. Please try again.": "errors.captchaFailed",
  "Too many requests. Please wait 60 seconds.": "errors.rateLimited",
  "Too many requests": "errors.rateLimited",
};

// Better Auth error codes (error.code) → i18n keys. Codes are stable across
// wording changes, unlike the exact-string map above; our own middlewares
// (rate-limit.ts, turnstile.ts) also return {error, code} with no `message`
// field at all, so without this branch every 429/403 fell to errors.generic.
const AUTH_CODE_MAP: Record<string, string> = {
  RATE_LIMITED: "errors.rateLimited",
  CAPTCHA_REQUIRED: "errors.captchaFailed",
  CAPTCHA_FAILED: "errors.captchaFailed",
  USER_ALREADY_EXISTS: "errors.userAlreadyExists",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "errors.userAlreadyExists",
  PASSWORD_TOO_SHORT: "errors.passwordTooShort",
  PASSWORD_TOO_LONG: "errors.passwordTooLong",
  INVALID_EMAIL: "errors.invalidEmail",
  INVALID_EMAIL_OR_PASSWORD: "errors.invalidCredentials",
  INVALID_USERNAME_OR_PASSWORD: "errors.invalidCredentials",
  EMAIL_NOT_VERIFIED: "errors.emailNotVerified",
  USERNAME_IS_ALREADY_TAKEN_PLEASE_TRY_ANOTHER: "errors.usernameTaken",
};

interface AuthErrorLike {
  message?: string;
  code?: string;
  status?: number;
  /** Our middlewares put the human text under `error`, not `message`. */
  error?: string;
}

export function getAuthErrorKey(error: string | AuthErrorLike | undefined | null): string {
  if (!error) return "errors.generic";
  const obj: AuthErrorLike = typeof error === "string" ? { message: error } : error;

  if (obj.code && AUTH_CODE_MAP[obj.code]) return AUTH_CODE_MAP[obj.code];
  if (obj.status === 429) return "errors.rateLimited";

  const message = obj.message ?? (typeof obj.error === "string" ? obj.error : undefined);
  if (!message) return "errors.generic";

  // Exact match first, then without the trailing period Better Auth appends
  // to some strings ("User already exists." vs "User already exists").
  const key = AUTH_ERROR_MAP[message] ?? AUTH_ERROR_MAP[message.replace(/\.$/, "")];
  if (key) return key;
  if (message.startsWith("Too many requests")) return "errors.rateLimited";

  console.warn(`[auth] Unmapped error message: "${message}"`);
  return "errors.generic";
}
