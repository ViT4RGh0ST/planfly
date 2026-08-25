import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { archivo } from "./fonts";
import { Toaster } from "@/components/ui/sonner";
import { normalizeLocale } from "@/i18n/config";
import { clientMessages } from "@/i18n/translator";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("ui.app");
  // The name is not translated: it is the name.
  return { title: "planfly", description: t("description") };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();

  return (
    // The font variable goes on <html> so that Radix's portals, which mount
    // outside <body>, inherit it too.
    <html lang={locale} className={`dark ${archivo.variable}`}>
      <body className="bg-background font-sans text-foreground antialiased">
        {/*
          Only `ui` and `domain` cross to the browser. `services` and `api` are
          worded on the server and travel already rendered, so shipping them
          would put ~250 messages into every page's payload for nothing.
        */}
        <NextIntlClientProvider messages={clientMessages(normalizeLocale(locale))}>
          <NuqsAdapter>{children}</NuqsAdapter>
          <Toaster richColors position="top-right" />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
