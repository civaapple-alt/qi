import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EventStore } from "@civaapple/qi-agent/kernel";
import { SessionIdSchema, assertSchema, type SessionId } from "@civaapple/qi-protocol";
import { EventStreamService, SessionEventHub, encodeSseEvent } from "@civaapple/qi-node/stream";
import { css, html, javascript } from "./assets.js";
import { ProjectEventStoreRegistry } from "./projects.js";
import { projectWebSession } from "./projection.js";

export interface WebServerOptions {
  /** Single-database mode (explicit `--db` / tests). */
  eventStore?: EventStore;
  /** Multi-project mode over `$QI_HOME/projects`. */
  projectsRoot?: string;
  eventHub?: SessionEventHub;
}

export class QiWebServer {
  readonly #server: Server;
  readonly #registry: ProjectEventStoreRegistry | undefined;
  readonly #singleStore: EventStore | undefined;
  readonly #hub: SessionEventHub;

  constructor(options: WebServerOptions) {
    if (Boolean(options.eventStore) === Boolean(options.projectsRoot)) {
      throw new TypeError("QiWebServer requires exactly one of eventStore or projectsRoot");
    }
    this.#hub = options.eventHub ?? new SessionEventHub();
    this.#singleStore = options.eventStore;
    this.#registry = options.projectsRoot ? new ProjectEventStoreRegistry(options.projectsRoot) : undefined;
    this.#server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (request.method !== "GET") return send(response, 405, "text/plain", "Method not allowed");
        if (url.pathname === "/") return send(response, 200, "text/html; charset=utf-8", html);
        if (url.pathname === "/style.css") return send(response, 200, "text/css; charset=utf-8", css);
        if (url.pathname === "/app.js") return send(response, 200, "text/javascript; charset=utf-8", javascript);
        if (url.pathname === "/api/meta") {
          return send(
            response,
            200,
            "application/json",
            JSON.stringify(
              this.#registry
                ? { mode: "projects", projectsRoot: this.#registry.projectsRoot }
                : { mode: "single" },
            ),
          );
        }
        if (url.pathname === "/api/projects") {
          if (!this.#registry) {
            return send(response, 200, "application/json", JSON.stringify([]));
          }
          return send(response, 200, "application/json", JSON.stringify(await this.#registry.list()));
        }
        if (url.pathname === "/api/sessions") {
          const store = await this.#storeFor(url);
          return send(response, 200, "application/json", JSON.stringify(store.listSessions()));
        }
        const match = /^\/api\/session\/([^/]+)(?:\/(history|events|workbench))?$/.exec(url.pathname);
        if (!match?.[1]) return send(response, 404, "text/plain", "Not found");
        const store = await this.#storeFor(url);
        const sessionId = assertSchema(SessionIdSchema, decodeURIComponent(match[1]), "session ID") as SessionId;
        const view = store.load(sessionId);
        if (!view) return send(response, 404, "text/plain", `Session ${sessionId} does not exist`);
        if (match[2] === "history") {
          return send(response, 200, "application/json", JSON.stringify(store.read(sessionId).events));
        }
        if (match[2] === "workbench") {
          const events = store.read(sessionId).events;
          return send(response, 200, "application/json", JSON.stringify({
            view,
            narrative: projectWebSession(view, events),
            events,
          }));
        }
        if (match[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? "0");
          if (!Number.isInteger(after) || after < 0) return send(response, 400, "text/plain", "Invalid after cursor");
          const streams = new EventStreamService(store, this.#hub);
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-content-type-options": "nosniff",
          });
          response.flushHeaders();
          const controller = new AbortController();
          request.once("close", () => controller.abort());
          for await (const event of streams.events(sessionId, after, controller.signal)) {
            response.write(encodeSseEvent(event));
          }
          response.end();
          return;
        }
        return send(response, 200, "application/json", JSON.stringify(view));
      } catch (error) {
        return send(response, 400, "text/plain", error instanceof Error ? error.message : String(error));
      }
    });
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ host: string; port: number; url: string }> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(port, host, () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo;
    return { host, port: address.port, url: `http://${host}:${address.port}` };
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.#server.close((error) => error ? reject(error) : resolve()));
    this.#registry?.close();
  }

  async #storeFor(url: URL): Promise<EventStore> {
    if (this.#singleStore) return this.#singleStore;
    if (!this.#registry) throw new TypeError("Web server has no EventStore");
    const project = url.searchParams.get("project")?.trim();
    if (!project) throw new TypeError("project query parameter is required");
    return this.#registry.open(project);
  }
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'",
  });
  response.end(body);
}
