import type { Metadata } from "next";
import Script from "next/script";
import type { ReactNode } from "react";

const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

export const metadata: Metadata = {
  title: "Workflow Hub | KeeperHub",
  description:
    "Discover and deploy community-built blockchain workflow automations. Browse featured templates, DeFi strategies, and monitoring setups.",
  openGraph: {
    title: "Workflow Hub | KeeperHub",
    description:
      "Discover and deploy community-built blockchain workflow automations.",
    type: "website",
    url: `${baseUrl}/hub`,
    siteName: "KeeperHub",
    images: [
      {
        url: `${baseUrl}/api/og/hub`,
        width: 1200,
        height: 630,
        alt: "KeeperHub Workflow Hub",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Workflow Hub | KeeperHub",
    description:
      "Discover and deploy community-built blockchain workflow automations.",
    images: [`${baseUrl}/api/og/hub`],
  },
};

type HubLayoutProps = {
  children: ReactNode;
};

// Workaround for a Next.js 16 dev-mode race: on browser back/forward
// navigation to /hub the framework occasionally streams an RSC payload
// the React client never finishes hydrating, leaving the page stuck on
// the loading skeleton with zero interactive elements. Detection point
// is `performance.getEntriesByType('navigation')[0]?.type === 'back_forward'`
// — a forced reload converts it into a normal navigation and React
// hydrates cleanly. Production is unaffected (NODE_ENV check below
// drops the script entirely from the prod build).
const HUB_DEV_BFCACHE_RELOAD =
  "if(typeof window!=='undefined'&&typeof performance!=='undefined'){var n=performance.getEntriesByType('navigation')[0];if(n&&n.type==='back_forward'){window.location.reload();}}";

export default function HubLayout({
  children,
}: HubLayoutProps): React.ReactElement {
  return (
    <>
      {process.env.NODE_ENV === "development" && (
        <Script id="hub-dev-bfcache-reload" strategy="beforeInteractive">
          {HUB_DEV_BFCACHE_RELOAD}
        </Script>
      )}
      {children}
    </>
  );
}
