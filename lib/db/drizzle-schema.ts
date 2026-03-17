// Drizzle-kit schema entrypoint
// drizzle-kit's .ts loader cannot resolve package exports that point to raw
// .ts files in node_modules, so this file uses relative filesystem paths.
// The runtime app uses combined-schema.ts (which goes through the package).
export * from "../../keeperhub-db/src/schema";
export * from "../../db/schema-extensions";
