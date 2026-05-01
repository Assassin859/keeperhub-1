import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Provider } from "jotai";
import Script from "next/script";
import { type ReactNode, Suspense } from "react";
import { AppBanner } from "@/components/app-banner";
import { AuthProvider } from "@/components/auth/provider";
import { KeeperHubExtensionLoader } from "@/components/extension-loader";
import { GitHubStarsLoader } from "@/components/github-stars-loader";
import { GitHubStarsProvider } from "@/components/github-stars-provider";
import { GlobalModals } from "@/components/global-modals";
import { PendingTemplateRunner } from "@/components/hub/pending-template-runner";
import { LayoutContent } from "@/components/layout-content";
import { MobileWarningDialog } from "@/components/mobile-warning-dialog";
import { OverlayProvider } from "@/components/overlays/overlay-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { mono, sans } from "@/lib/fonts";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com"
  ),
  title: "KeeperHub - Blockchain Workflow Automation",
  description:
    "Build powerful blockchain workflow automations with a visual, node-based editor. Built with Next.js and React Flow.",
  openGraph: {
    title: "KeeperHub - Blockchain Workflow Automation",
    description:
      "Build powerful blockchain workflow automations with a visual, node-based editor.",
    type: "website",
    siteName: "KeeperHub",
    images: [
      {
        url: "/api/og/default",
        width: 1200,
        height: 630,
        alt: "KeeperHub - Blockchain Workflow Automation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "KeeperHub - Blockchain Workflow Automation",
    description:
      "Build powerful blockchain workflow automations with a visual, node-based editor.",
    images: ["/api/og/default"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// Workaround for a Next.js 16 dev-mode race: on browser back-or-forward
// navigation (including Cmd+Shift+T tab restore) the framework
// occasionally streams an RSC payload the React client never finishes
// hydrating, leaving client-component-heavy pages (/hub, /billing, etc.)
// stuck on the loading skeleton with zero interactive elements.
// Detection uses the Performance Navigation Timing API to check the
// navigation type; a forced reload converts the back-or-forward entry
// into a normal navigation and React hydrates cleanly. Production is
// unaffected — the JSX gate below uses process.env.NODE_ENV which
// Webpack/Turbopack inline-substitute at build time, so the entire
// <Script> element is dead-code-eliminated from prod bundles.
const ROOT_DEV_BFCACHE_RELOAD =
  "if(typeof window!=='undefined'&&typeof performance!=='undefined'){var n=performance.getEntriesByType('navigation')[0];if(n&&n.type==='back_forward'){window.location.reload();}}";

// Pre-paint inline script: read the persisted nav-sidebar state from
// localStorage and set --nav-sidebar-width on documentElement BEFORE
// React hydrates. Without this, page shells using
// `md:ml-[var(--nav-sidebar-width,60px)]` paint at the 60px fallback
// margin, then animate to 200px when NavigationSidebar mounts and
// applies the variable in a useEffect — visible content shift.
//
// Width values MUST match COLLAPSED_WIDTH (60) and EXPANDED_WIDTH (200)
// in components/navigation-sidebar.tsx. DEFAULT_STATE.sidebar=true in
// lib/hooks/use-persisted-nav-state.ts means new users default to
// expanded, so 200 is the right pre-paint guess.
const ROOT_NAV_WIDTH_PREPAINT =
  "try{var r=localStorage.getItem('keeperhub-nav-state');var w=200;if(r){var p=JSON.parse(r);if(p&&p.sidebar===false){w=60;}}document.documentElement.style.setProperty('--nav-sidebar-width',w+'px');}catch(e){}";

type RootLayoutProps = {
  children: ReactNode;
};

const RootLayout = ({ children }: RootLayoutProps) => (
  <html lang="en" suppressHydrationWarning>
    <body className={cn(sans.variable, mono.variable, "antialiased")}>
      {/* Pre-paint inline script — runs during HTML parsing BEFORE the
          page content below it is laid out, so md:ml-[var(--nav-sidebar-width,60px)]
          wrappers paint at the correct margin and no margin-left
          transition fires on first render. Must stay as the first body
          child for the timing guarantee. */}
      <Script id="root-nav-width-prepaint" strategy="beforeInteractive">
        {ROOT_NAV_WIDTH_PREPAINT}
      </Script>
      <KeeperHubExtensionLoader />
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        disableTransitionOnChange
        enableSystem
      >
        <Provider>
          <AuthProvider>
            <PendingTemplateRunner />
            <OverlayProvider>
              <Suspense fallback={<GitHubStarsProvider stars={null} />}>
                <GitHubStarsLoader />
              </Suspense>
              <AppBanner />
              <LayoutContent>{children}</LayoutContent>
              <Toaster />
              <GlobalModals />
              <MobileWarningDialog />
            </OverlayProvider>
          </AuthProvider>
        </Provider>
      </ThemeProvider>
      {process.env.NODE_ENV === "development" && (
        <Script id="root-dev-bfcache-reload" strategy="beforeInteractive">
          {ROOT_DEV_BFCACHE_RELOAD}
        </Script>
      )}
    </body>
  </html>
);

export default RootLayout;
