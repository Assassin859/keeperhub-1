export function CoalitionIcon({
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
      <title>Coalition</title>
      <circle cx="6" cy="9" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <circle cx="12" cy="17" r="2.5" />
      <path d="M8 10.5l3 5" />
      <path d="M16 10.5l-3 5" />
      <path d="M8.5 9h7" />
    </svg>
  );
}
