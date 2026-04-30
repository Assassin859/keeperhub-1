import { cookies } from "next/headers";
import HubViewShell from "./_view-shell";

type View = "cards" | "list";

function readView(value: string | undefined): View {
  return value === "list" ? "list" : "cards";
}

export default async function HubPage(): Promise<React.ReactElement> {
  const cookieStore = await cookies();
  const initialView = readView(cookieStore.get("hub_view")?.value);
  return <HubViewShell initialView={initialView} />;
}
