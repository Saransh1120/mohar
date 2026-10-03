import { buildGateway } from "./app.js";
import { configFromEnv } from "./config.js";

let config;
try {
  config = configFromEnv(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const app = await buildGateway({ config });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.fatal({ err }, "failed to start");
  process.exit(1);
}

app.log.info(
  { port: config.port, host: config.host, ledger: config.upstreamUrl },
  "gateway listening",
);
// Said once at boot, because each of these changes what the limits mean.
if (config.trustProxy === false) {
  app.log.info(
    "TRUST_PROXY is not set: the address a request arrives from is taken as the caller. " +
      "Behind a reverse proxy that is the proxy, and every caller shares one allowance.",
  );
}
if (!config.gatewaySecret) {
  app.log.info(
    "GATEWAY_SECRET is not set: the ledger must be bound to loopback (HOST=127.0.0.1), " +
      "or it can be reached around this gateway.",
  );
}
