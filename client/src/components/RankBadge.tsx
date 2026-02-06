import { Crown, Star, Shield, User } from "lucide-react";
import { cn } from "@/lib/utils";

interface RankBadgeProps {
  rank: string;
  className?: string;
}

export function RankBadge({ rank, className }: RankBadgeProps) {
  let icon = <User className="w-3 h-3 mr-1" />;
  let style = "bg-slate-800 text-slate-400 border-slate-700";

  const lowerRank = rank.toLowerCase();

  if (lowerRank.includes("admin") || lowerRank.includes("адмін")) {
    icon = <Shield className="w-3 h-3 mr-1" />;
    style = "bg-red-500/10 text-red-400 border-red-500/20";
  } else if (lowerRank.includes("shop") || lowerRank.includes("шоп")) {
    icon = <Crown className="w-3 h-3 mr-1" />;
    style = "bg-yellow-500/10 text-yellow-400 border-yellow-500/20";
  } else if (lowerRank.includes("pro") || lowerRank.includes("про")) {
    icon = <Star className="w-3 h-3 mr-1" />;
    style = "bg-blue-500/10 text-blue-400 border-blue-500/20";
  }

  return (
    <span
      className={cn(
        "inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border",
        style,
        className
      )}
    >
      {icon}
      {rank}
    </span>
  );
}
