import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function resolveMonacoDir() {
  const reactPkgPath = require.resolve("@monaco-editor/react/package.json");
  const reactRequire = createRequire(pathToFileURL(reactPkgPath));
  const loaderPkgPath = reactRequire.resolve("@monaco-editor/loader/package.json");
  const loaderRequire = createRequire(pathToFileURL(loaderPkgPath));
  const monacoPkgPath = loaderRequire.resolve("monaco-editor/package.json");
  return dirname(monacoPkgPath);
}

const monacoDir = resolveMonacoDir();
const srcDir = join(monacoDir, "min", "vs");
const destDir = join(process.cwd(), "public", "monaco", "vs");

await rm(destDir, { recursive: true, force: true });
await cp(srcDir, destDir, { recursive: true });

console.log(`copy-monaco: ${srcDir} -> ${destDir}`);
