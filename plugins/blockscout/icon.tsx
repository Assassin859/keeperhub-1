export function BlockscoutIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-label="Blockscout logo"
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Blockscout</title>
      <rect
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.6"
        width="6"
        x="3"
        y="3"
      />
      <rect
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.6"
        width="6"
        x="15"
        y="3"
      />
      <rect
        height="6"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.6"
        width="6"
        x="3"
        y="15"
      />
      <rect
        fill="currentColor"
        height="6"
        rx="1"
        width="6"
        x="15"
        y="15"
      />
    </svg>
  );
}
