import http from "node:http";
import https from "node:https";

/**
 * The one connection the gateway has to the ledger.
 *
 * Plain `node:http`, streamed in both directions. A response is piped as it
 * arrives rather than collected, which is what lets the two server-sent event
 * streams pass through without being held back to fill a buffer.
 *
 * The gateway holds no database credential. Everything it knows about an
 * account or a device it asks the ledger for over this connection, so a
 * compromised gateway can do what the ledger's API allows and nothing more.
 */

/** The header the ledger checks when it is told to answer only to its gateway. */
export const GATEWAY_SECRET_HEADER = "x-mohar-gateway";

export interface UpstreamJson {
  status: number;
  json: unknown;
}

export class Upstream {
  private readonly base: URL;
  private readonly agent: http.Agent;
  private readonly lib: typeof http | typeof https;

  constructor(
    baseUrl: string,
    private readonly secret: string | null,
  ) {
    this.base = new URL(baseUrl);
    const secure = this.base.protocol === "https:";
    this.lib = secure ? https : http;
    this.agent = secure
      ? new https.Agent({ keepAlive: true, maxSockets: 64 })
      : new http.Agent({ keepAlive: true, maxSockets: 64 });
  }

  get origin(): string {
    return this.base.origin;
  }

  /** Open a request and hand back the response as a stream. */
  request(
    method: string,
    pathAndQuery: string,
    headers: Record<string, string>,
    body: Buffer | null,
    onResponse: (res: http.IncomingMessage) => void,
    onError: (err: Error) => void,
  ): http.ClientRequest {
    const req = this.lib.request(
      {
        protocol: this.base.protocol,
        hostname: this.base.hostname,
        port: this.base.port,
        method,
        path: pathAndQuery,
        agent: this.agent,
        headers: {
          ...headers,
          ...(this.secret ? { [GATEWAY_SECRET_HEADER]: this.secret } : {}),
          ...(body ? { "content-length": String(body.length) } : {}),
        },
      },
      onResponse,
    );
    req.on("error", onError);
    req.end(body ?? undefined);
    return req;
  }

  /** A small JSON read the gateway makes on its own behalf. */
  getJson(path: string, headers: Record<string, string> = {}): Promise<UpstreamJson> {
    return new Promise((resolve, reject) => {
      const req = this.request(
        "GET",
        path,
        { accept: "application/json", ...headers },
        null,
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () => {
            let json: unknown = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              /* a body that is not JSON is reported as null with its status */
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
        reject,
      );
      req.setTimeout(5_000, () => req.destroy(new Error("the ledger did not answer in 5 s")));
    });
  }

  close(): void {
    this.agent.destroy();
  }
}
