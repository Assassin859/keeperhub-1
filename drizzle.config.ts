import { config } from "dotenv";
import type { Config } from "drizzle-kit";
import { getDatabaseUrl } from "./keeperhub-db/src/connection-utils";

config();

export default {
  schema: "./lib/db/drizzle-schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: getDatabaseUrl(),
  },
} satisfies Config;
