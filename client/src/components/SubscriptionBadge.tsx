import { cn } from "@/lib/utils";

type SubscriptionType = "BASIC" | "BASIC+" | "SHOP";

interface SubscriptionBadgeProps {
  type: string; // Using string to accept values from API even if not strictly typed yet
  className?: string;
}

export function SubscriptionBadge({ type, className }: SubscriptionBadgeProps) {
  const styles: Record<string, string> = {
    BASIC: "bg-slate-800/80 text-slate-300 border-slate-700",
    "BASIC+": "bg-indigo-500/10 text-indigo-300 border-indigo-500/20 shadow-[0_0_10px_-3px_rgba(99,102,241,0.2)]",
    SHOP: "bg-amber-500/10 text-amber-300 border-amber-500/20 shadow-[0_0_10px_-3px_rgba(245,158,11,0.2)]",
  };

  const labels: Record<string, string> = {
    BASIC: "Basic",
    "BASIC+": "Basic Plus",
    SHOP: "Shop Pro",
  };

  const safeType = type as SubscriptionType;
  const style = styles[safeType] || styles.BASIC;
  const label = labels[safeType] || type;

  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors",
        style,
        className
      )}
    >
      {label}
    </span>
  );
}
