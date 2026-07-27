import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultProjectsRoot,
  parseWebCliArguments,
  WEB_CLI_USAGE,
  WebCliHelp,
} from "@civaapple/qi-web";

test("Web CLI accepts the database as a positional npm script argument", () => {
  assert.deepEqual(parseWebCliArguments([".qi/qi.sqlite"], {}), {
    mode: "single",
    dbPath: ".qi/qi.sqlite",
    port: 4317,
    host: "127.0.0.1",
  });
});

test("Web CLI keeps explicit and equals-style options compatible", () => {
  assert.deepEqual(
    parseWebCliArguments(
      ["--db", "data.sqlite", "--port=8080", "--host", "0.0.0.0"],
      {},
    ),
    { mode: "single", dbPath: "data.sqlite", port: 8080, host: "0.0.0.0" },
  );
});

test("Web CLI supports environment configuration with CLI precedence", () => {
  const environment = {
    QI_WEB_DB: "environment.sqlite",
    QI_WEB_PORT: "9000",
    QI_WEB_HOST: "localhost",
  };
  assert.deepEqual(parseWebCliArguments(["cli.sqlite", "--port", "7000"], environment), {
    mode: "single",
    dbPath: "cli.sqlite",
    port: 7000,
    host: "localhost",
  });
});

test("Web CLI defaults to QI_HOME/projects when no database is given", () => {
  const environment = { QI_HOME: "D:\\qi-home" };
  assert.deepEqual(parseWebCliArguments([], environment), {
    mode: "projects",
    projectsRoot: defaultProjectsRoot(environment),
    port: 4317,
    host: "127.0.0.1",
  });
  assert.deepEqual(
    parseWebCliArguments(["--projects", "C:\\custom\\projects", "--port", "4321"], {}),
    { mode: "projects", projectsRoot: "C:\\custom\\projects", port: 4321, host: "127.0.0.1" },
  );
});

test("Web CLI rejects ambiguous and invalid arguments", () => {
  assert.throws(
    () => parseWebCliArguments(["positional.sqlite", "--db", "flag.sqlite"], {}),
    /either positionally or with --db/,
  );
  assert.throws(
    () => parseWebCliArguments(["--db", "a.sqlite", "--projects", "p"], {}),
    /database|--projects/,
  );
  assert.throws(() => parseWebCliArguments(["--db"], {}), /--db requires a value/);
  assert.throws(() => parseWebCliArguments(["--unknown"], {}), /Unknown argument/);
  assert.throws(() => parseWebCliArguments(["a.sqlite", "b.sqlite"], {}), /Unexpected positional/);
  assert.throws(() => parseWebCliArguments(["a.sqlite", "--port", "70000"], {}), /Invalid port/);
});

test("Web CLI exposes help as a distinct non-error control path", () => {
  assert.throws(
    () => parseWebCliArguments(["--help"], {}),
    (error) => error instanceof WebCliHelp && error.message === WEB_CLI_USAGE,
  );
});
