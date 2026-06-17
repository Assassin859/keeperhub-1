import type { SuggestionCategory } from "@/lib/scan/suggestions/types";

const CATEGORY_LABELS: Record<SuggestionCategory, string> = {
  health: "Health",
  yield: "Yield",
  alert: "Alert",
  claim: "Claim",
};

function categoryBadgeClass(category: SuggestionCategory): string {
  const base =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium";
  switch (category) {
    case "health":
      return `${base} bg-[var(--color-badge-health-bg)] text-[var(--color-badge-health-text)] border-[var(--color-badge-health-border)]`;
    case "yield":
      return `${base} bg-[var(--color-bg-accent)] text-[var(--color-text-accent)] border-[var(--color-border-accent)]`;
    case "alert":
      return `${base} bg-[var(--color-bg-error)] text-[var(--color-text-error)] border-[var(--color-border-error)]`;
    case "claim":
      return `${base} bg-[var(--color-badge-blue-bg)] text-[var(--color-badge-blue-text)] dark:text-[var(--color-badge-blue-text-dark)] border-[var(--color-badge-blue-border)]`;
    default:
      return base;
  }
}

type CategoryBadgeProps = {
  category: SuggestionCategory;
};

export function CategoryBadge({
  category,
}: CategoryBadgeProps): React.ReactElement {
  return (
    <span
      aria-label={`Category: ${category}`}
      className={categoryBadgeClass(category)}
      role="img"
    >
      {CATEGORY_LABELS[category]}
    </span>
  );
}
