// Writes docs/openapi.json from the built application. Run through
// `npm run openapi`, which builds first. The document depends on the code
// alone: the configuration below only lets the application start, and none
// of it appears in the output. An integration test fails when the committed
// file no longer matches the code.
import { writeFile } from "node:fs/promises";
import { format, resolveConfig } from "prettier";
import { createApp } from "../dist/app.js";
import { loadConfig } from "../dist/config/core/config.js";
import { openApiDocument } from "../dist/openapi.js";

const config = loadConfig({
  SOLANA_NETWORK: "devnet",
  ALLOWED_ORIGINS: "http://localhost:3999",
  SUPABASE_URL: "http://127.0.0.1:54421",
  SUPABASE_PUBLISHABLE_KEY: "documentation-only",
});
const app = await createApp(config, () => undefined);
const document = openApiDocument(app);
await app.close();

const target = new URL("../docs/openapi.json", import.meta.url);
// Formatted as `npm run format:check` expects the file, by the repository's own Prettier settings.
const style = await resolveConfig(target);
await writeFile(target, await format(JSON.stringify(document), { ...style, parser: "json" }));
console.log(`Wrote docs/openapi.json: ${Object.keys(document.paths).length} paths.`);
