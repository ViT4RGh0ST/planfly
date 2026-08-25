import { Nav } from "@/components/nav";
import { requireSession } from "@/lib/session";
import { pendingReviewCount } from "@/lib/services/reports";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireSession();

  const nav = (
    <Nav
      pendingReview={await pendingReviewCount(ctx.householdId)}
      householdName={ctx.householdName}
      userName={ctx.email}
      locale={ctx.locale}
    />
  );

  return (
    // On narrow screens the navigation goes on top horizontally; on the desktop,
    // on the left. The border only exists on the desktop: on the horizontal bar
    // the nav puts it there itself.
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="shrink-0 md:w-56 md:border-r md:border-sidebar-border">{nav}</aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
