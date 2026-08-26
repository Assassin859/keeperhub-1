import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SitePageView } from "@/components/site/site-page-view";
import { publicPage } from "@/lib/site/content";
import { siteMetadata } from "@/lib/site/metadata";

const PATH = "/pricing";

export function generateMetadata(): Metadata {
  return siteMetadata(PATH);
}

export default function Page(): React.ReactElement {
  const page = publicPage(PATH);
  if (!page) {
    notFound();
  }
  return <SitePageView page={page} />;
}
