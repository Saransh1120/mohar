import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Preserve the old HTTP paths while access runs in its own process. */
export function registerAccessProxy(app: FastifyInstance, upstream: string): void {
  const base = new URL(upstream);
  if (!(["http:", "https:"].includes(base.protocol))) throw new Error("ACCESS_URL must use HTTP(S)");
  const forward = async (req: FastifyRequest, reply: FastifyReply) => {
    const url = new URL(req.url, base);
    const res = await fetch(url, {
      method: req.method,
      headers: { "content-type": "application/json" },
      ...(req.method === "GET" ? {} : { body: JSON.stringify(req.body ?? {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    return reply.code(res.status).type(res.headers.get("content-type") ?? "application/json").send(await res.text());
  };
  app.all("/access/*", forward);
  app.all("/keys", forward);
  app.all("/keys/*", forward);
}
