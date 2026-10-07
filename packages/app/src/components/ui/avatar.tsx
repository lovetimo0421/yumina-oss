import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";
import { resolveImageUrl, cardImageUrl, originalImageUrl } from "@/lib/asset-url";

const Avatar = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn(
      "relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full",
      className
    )}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, src, onLoadingStatusChange, ...props }, ref) => {
  const resized = cardImageUrl(src, 128) ?? resolveImageUrl(src);
  const original = resized ? originalImageUrl(resized) : undefined;
  // Radix preloads the image before mounting <img>, so an img onError handler
  // never sees a failed resize. Retry the original via its loading callback.
  // Key the failure by URL so another creator's avatar gets a fresh attempt.
  const [failedResize, setFailedResize] = React.useState<string>();
  return (
  // Resolve raw S3 keys / @asset refs into CDN URLs here so avatars render
  // everywhere, even from endpoints that return `user.image` unresolved. Also
  // size them through the CF resizer (~128px) so a user who uploaded a multi-MB
  // avatar doesn't ship the full original for a 40px circle. Foreign OAuth
  // avatar URLs (Google/Discord) pass through untransformed.
  <AvatarPrimitive.Image
    ref={ref}
    src={failedResize === resized ? original : resized}
    onLoadingStatusChange={(status) => {
      if (status === "error" && resized && original !== resized && failedResize !== resized) {
        setFailedResize(resized);
        return;
      }
      onLoadingStatusChange?.(status);
    }}
    decoding="async"
    className={cn("aspect-square h-full w-full", className)}
    {...props}
  />
  );
});
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ComponentRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn(
      "flex h-full w-full items-center justify-center rounded-full bg-muted",
      className
    )}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
