#!/usr/bin/env node
/**
 * hermes3d-hostproxy — tiny loopback bridge for the Hermes3D studio.
 *
 * Why this exists
 * ---------------
 * `hermes serve` (the JSON-RPC gateway Studio talks to) only accepts a
 * WebSocket upgrade whose `Host` header is localhost. It also refuses plain
 * `?token=` auth on any non-loopback bind. Hermes3D, for its part, only routes
 * the browser through its own server-side proxy (which injects the token, so
 * the secret never reaches the browser) when the configured upstream URL is a
 * NON-loopback host — a loopback upstream makes the browser connect directly
 * and fail without the token.
 *
 * This proxy squares the two: it listens on a non-loopback address (the
 * Tailscale IP, tailnet only), forwards to 127.0.0.1:9120 and rewrites the
 * `Host` header to `localhost`. Studio therefore connects through its own
 * proxy with the token from .env, and the backend sees a loopback Host.
 *
 * Usage:  node deploy/hermes3d-hostproxy.js
 * Env:    HOSTPROXY_LISTEN_HOST (default 127.0.0.1)
 *         HOSTPROXY_LISTEN_PORT (default 9121)
 *         HOSTPROXY_UPSTREAM_HOST (default 127.0.0.1)
 *         HOSTPROXY_UPSTREAM_PORT (default 9120)
 *         HOSTPROXY_HOST_HEADER (default localhost)
 */
"use strict";

const http = require("node:http");
const net = require("node:net");

const LISTEN_HOST = process.env.HOSTPROXY_LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.HOSTPROXY_LISTEN_PORT || 9121);
const UPSTREAM_HOST = process.env.HOSTPROXY_UPSTREAM_HOST || "127.0.0.1";
const UPSTREAM_PORT = Number(process.env.HOSTPROXY_UPSTREAM_PORT || 9120);
const HOST_HEADER = process.env.HOSTPROXY_HOST_HEADER || "localhost";

const log = (...args) => console.log("[hostproxy]", ...args);

/** Rewrite the Host header (and drop hop-by-hop framing the socket re-does). */
const rewriteHead = (rawHead) => {
  const [requestLine, ...headerLines] = rawHead.split("\r\n");
  const kept = headerLines.filter((line) => {
    const name = line.split(":", 1)[0].trim().toLowerCase();
    return name && name !== "host";
  });
  return [requestLine, `Host: ${HOST_HEADER}`, ...kept].join("\r\n");
};

const server = http.createServer((req, res) => {
  if (process.env.HOSTPROXY_LOG_REQUESTS === "1") {
    log(`${req.method} ${req.url}`);
  }
  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: HOST_HEADER },
    },
    (upstreamRes) => {
      if (process.env.HOSTPROXY_LOG_REQUESTS === "1") {
        log(`  -> ${upstreamRes.statusCode} ${req.url}`);
      }
      const headers = { ...upstreamRes.headers };
      // A plain-HTTP tailnet origin breaks on Next's `upgrade-insecure-requests`
      // CSP directive: the browser rewrites every subresource (and the WS) to
      // https:// on the same port, where nothing is listening. Browsers exempt
      // localhost, which is why this only bites remote clients.
      if (
        process.env.HOSTPROXY_STRIP_CSP_UPGRADE === "1" &&
        typeof headers["content-security-policy"] === "string"
      ) {
        headers["content-security-policy"] = headers["content-security-policy"]
          .split(";")
          .filter((part) => part.trim().toLowerCase() !== "upgrade-insecure-requests")
          .join(";");
      }
      res.writeHead(upstreamRes.statusCode || 502, headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${err.message}`);
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (process.env.HOSTPROXY_LOG_REQUESTS === "1") {
    log(`UPGRADE ${req.url}`);
  }
  const upstream = net.connect(UPSTREAM_PORT, UPSTREAM_HOST, () => {
    const rawHead = rewriteHead(
      [ `${req.method} ${req.url} HTTP/1.1`, ...flattenHeaders(req.rawHeaders) ].join("\r\n")
    );
    upstream.write(`${rawHead}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  const destroyBoth = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", destroyBoth);
  socket.on("error", destroyBoth);
  socket.on("close", () => upstream.end());
});

/** rawHeaders is a flat [name, value, name, value, ...] array. */
function flattenHeaders(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    out.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  }
  return out;
}

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(
    `listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT} (Host: ${HOST_HEADER})`
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
