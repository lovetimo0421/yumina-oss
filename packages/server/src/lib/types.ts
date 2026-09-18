export type SessionUser = {
  id: string;
  /** Account display name — user-editable, may change over time. Use only for
   *  account-level UI (profile dropdown etc.). For in-world identity (what
   *  `{{user}}` resolves to and the sandbox `user.name` surfaces), prefer
   *  `username` which is stable and unique. */
  name: string;
  /** Stable `@handle` from the better-auth username plugin — unique per account,
   *  used as the fallback for `{{user}}` when no persona is active. Auto-generated
   *  for OAuth signups (see generateUniqueUsername in auth.ts). May be null only
   *  for legacy rows pre-dating the plugin. */
  username: string | null;
  /** Case-preserved / formatted variant of username (e.g. "JaneDoe" vs "janedoe"). */
  displayUsername: string | null;
  email: string;
  emailVerified: boolean;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  role?: string;
  isSuspended?: boolean;
  isBanned?: boolean;
  tier?: string;
  /** Admin-granted trusted-creator flag: edits auto-publish without review and
   *  the publishing rate-limit tier uses the trusted (higher) window. */
  skipReview?: boolean;
};

export type AppEnv = {
  Variables: {
    user: SessionUser;
    session: {
      id: string;
      userId: string;
      expiresAt: Date;
      token: string;
    };
  };
};
