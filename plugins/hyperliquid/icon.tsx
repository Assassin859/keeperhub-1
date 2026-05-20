export function HyperliquidIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-label="Hyperliquid"
    >
      <title>Hyperliquid</title>
      <path d="M4 4v16" />
      <path d="M20 4v16" />
      <path d="M4 12c2-2.5 4-2.5 6 0s4 2.5 6 0s4-2.5 4 0" />
    </svg>
  );
}
