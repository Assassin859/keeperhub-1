export function RobinhoodIcon({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      className={className}
      fill="none"
      height="148"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.25"
      style={style}
      viewBox="0 0 24 24"
      width="148"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Robinhood Chain</title>
      {/* A price line over a baseline: a quoted instrument, not a coin. */}
      <path d="M3 20h18" />
      <path d="M4 16l4.5-5 3.5 3.5L20 6" />
      <path d="M15.5 6H20v4.5" />
    </svg>
  );
}
