"use client";

import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheckIcon,
  InfoIcon,
  TriangleAlertIcon,
  OctagonXIcon,
  Loader2Icon,
} from "lucide-react";

/**
 * The toasts, in the app's design system.
 *
 * Three things that were wrong and only showed up on measuring:
 *
 * 1. **The theme came from `useTheme()`**, which returns "system" and resolves
 *    through `prefers-color-scheme`. But the app pins `class="dark"` on the
 *    `<html>` and has no toggle: anyone with their system set to light saw a
 *    white box over a black screen, with the error text at 4,35:1 — below WCAG's
 *    4,5:1. Here we say "dark" because it is the only thing the app is.
 *
 * 2. **Only `--normal-*` was overridden**, which sonner applies to the *normal*
 *    type. The only two types the app uses — `success` and `error` — read
 *    `--success-*` and `--error-*`, which nobody defined, so they kept the
 *    factory palette. That is why the toast looked like nothing else.
 *
 * 3. **An error announced itself as politely as a success** and left after five
 *    seconds. The app's longest message is 132 characters: reading it whole in
 *    that time demands 276 words per minute. Errors now stay until you close them.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      // The container carries an `aria-label`, and it was in English.
      containerAriaLabel="Avisos"
      closeButton
      // Eight seconds, not five. The app's longest message is 132 characters:
      // reading it in five demanded 276 words per minute. And now there is a close
      // button, which is what was genuinely missing.
      duration={8000}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--popover)",
          "--success-text": "var(--positive)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--negative)",
          "--error-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
