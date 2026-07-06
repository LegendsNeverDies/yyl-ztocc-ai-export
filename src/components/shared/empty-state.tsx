import { cn } from "@/lib/utils";
import { PackageOpen } from "lucide-react";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn("empty-state", className)}>
      {icon || <PackageOpen className="h-16 w-16 opacity-30" />}
      <h3 className="mt-4 text-base font-semibold text-[#4e5969]">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-[#86909c]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
