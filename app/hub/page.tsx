import { cookies } from "next/headers";
import HubViewShell from "./_view-shell";

type View = "cards" | "list";

type HubPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function readView(value: string | undefined): View {
  return value === "list" ? "list" : "cards";
}

function readTagSlug(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export default async function HubPage({
  searchParams,
}: HubPageProps): Promise<React.ReactElement> {
  const [cookieStore, params] = await Promise.all([cookies(), searchParams]);
  const initialView = readView(cookieStore.get("hub_view")?.value);
  const initialTagSlug = readTagSlug(params.tag);
  return (
    <HubViewShell initialTagSlug={initialTagSlug} initialView={initialView} />
  );
}
