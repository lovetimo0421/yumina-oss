/** A font value that defers to the theme rather than naming a face — unset,
 *  or a `var(--yc-font, …)` the starters write. The picker shows it as
 *  「跟着主题」, never as the raw CSS. */
export const isThemeFontValue = (value: string | undefined): boolean => !value || /^\s*var\(/.test(value);
