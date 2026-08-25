"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { refreshRates } from "@/app/(app)/actions";
import { cn } from "@/lib/utils";

export function RefreshRatesButton() {
  const t = useTranslations();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshRates();
          if (result?.ok) toast.success(result.message);
          else if (result) toast.error(result.message);
        })
      }
    >
      <RefreshCw className={cn("size-4", pending && "animate-spin")} />
      {t("ui.rates.refreshNow")}
    </Button>
  );
}
