"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type ConsentResult = { redirect_uri?: string; error?: { message?: string } };

function McpConsentForm() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = searchParams.get("client_id") ?? t("ui.mcpConsent.unknownClient");
  const scope = searchParams.get("scope")?.split(" ").filter(Boolean) ?? [];

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    const response = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ accept, oauth_query: searchParams.toString() }),
    });
    const body = (await response.json().catch(() => ({}))) as ConsentResult;
    if (!response.ok || !body.redirect_uri) {
      setError(body.error?.message ?? t("ui.mcpConsent.error"));
      setPending(false);
      return;
    }
    window.location.assign(body.redirect_uri);
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t("ui.mcpConsent.title")}</CardTitle>
          <CardDescription>
            {t("ui.mcpConsent.description", { client })}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div>
            <p className="mb-2 text-sm font-medium">{t("ui.mcpConsent.permissions")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {scope.length ? scope.map((item) => <li key={item}>{item}</li>) : <li>{t("ui.mcpConsent.noPermissions")}</li>}
            </ul>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <Button disabled={pending} onClick={() => decide(true)}>{t("ui.mcpConsent.allow")}</Button>
            <Button disabled={pending} variant="outline" onClick={() => decide(false)}>{t("ui.mcpConsent.deny")}</Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}

export default function McpConsentPage() {
  return (
    <Suspense fallback={<main className="min-h-svh" />}>
      <McpConsentForm />
    </Suspense>
  );
}
