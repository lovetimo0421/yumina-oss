import { APIError, createAuthMiddleware } from "better-auth/api";
import { username, USERNAME_ERROR_CODES } from "better-auth/plugins/username";
import { isReservedUsername, USERNAME_RE } from "@yumina/shared";

export function usernameAuthPlugin() {
  const plugin = username({
    minUsernameLength: 3,
    maxUsernameLength: 20,
    // Better Auth also runs this validator during sign-in. Existing official
    // accounts must pass it so their credentials can be checked normally.
    usernameValidator: (value: string) => USERNAME_RE.test(value),
  });

  plugin.hooks.before.unshift({
    matcher: (context) => context.path === "/sign-up/email"
      || context.path === "/update-user"
      || context.path === "/is-username-available",
    handler: createAuthMiddleware(async (context) => {
      // Better Auth fills a missing username from displayUsername on writes.
      // Validate that effective handle before the plugin performs the copy.
      const value = context.body?.username || (
        context.path === "/is-username-available" ? undefined : context.body?.displayUsername
      );
      if (typeof value === "string" && isReservedUsername(value)) {
        throw APIError.from(
          context.path === "/is-username-available" ? "UNPROCESSABLE_ENTITY" : "BAD_REQUEST",
          USERNAME_ERROR_CODES.INVALID_USERNAME,
        );
      }
    }),
  });

  return plugin;
}
