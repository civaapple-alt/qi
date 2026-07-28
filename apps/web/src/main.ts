#!/usr/bin/env node
import { resolve } from "node:path";
import { SqliteEventStore } from "@civaapple/qi-node/storage";
import { parseWebCliArguments, WEB_CLI_USAGE, WebCliHelp } from "./cli.js";
import { QiWebServer } from "./server.js";

let options;
try {
  options = parseWebCliArguments(process.argv.slice(2));
} catch (error) {
  if (error instanceof WebCliHelp) {
    process.stdout.write(`${WEB_CLI_USAGE}\n`);
    process.exit(0);
  }
  throw error;
}

const store = options.mode === "single"
  ? new SqliteEventStore(resolve(options.dbPath), { readonly: true })
  : undefined;
const server = options.mode === "single"
  ? new QiWebServer({ eventStore: store! })
  : new QiWebServer({ projectsRoot: resolve(options.projectsRoot) });
const address = await server.listen(options.port, options.host);
if (options.mode === "projects") {
  process.stdout.write(`Qi Web · ${address.url}\nprojects ${resolve(options.projectsRoot)}\n`);
} else {
  process.stdout.write(`Qi Web · ${address.url}\ndatabase ${resolve(options.dbPath)}\n`);
}
const close = async () => {
  await server.close();
  store?.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
