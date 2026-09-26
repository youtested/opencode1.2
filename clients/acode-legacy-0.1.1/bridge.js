const http = require("http");
const { URL } = require("url");

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 8768) || 8768;
const defaultTarget = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const targetHeader = "x-opencode-target";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

function setCors(headers) {
  const output = { ...headers };
  if (!output["access-control-allow-origin"]) output["access-control-allow-origin"] = "*";
  output["access-control-allow-headers"] = "Authorization, Content-Type, X-OpenCode-Control-Token";
  output["access-control-allow-methods"] = "GET, POST, OPTIONS";
  output["cache-control"] = "no-store";
  return output;
}

const server = http.createServer((request, response) => {
  if (request.url === "/__bridge_health") {
    sendJson(response, 200, { ok: true, service: "opencode-acode-bridge", port });
    return;
  }
  if (request.method === "OPTIONS") {
    response.writeHead(204, setCors({}));
    response.end();
    return;
  }
  const requestedTarget = request.headers[targetHeader];
  const target = String(requestedTarget || defaultTarget).replace(/\/$/, "");
  let targetUrl;
  try {
    targetUrl = new URL(request.url || "/", target.endsWith("/") ? target : target + "/");
  } catch (_) {
    sendJson(response, 400, { error: "Invalid bridge target" });
    return;
  }
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  delete headers[targetHeader];
  headers.host = targetUrl.host;
  const proxy = http.request(targetUrl, { method: request.method, headers }, upstream => {
    response.writeHead(upstream.statusCode || 502, setCors(upstream.headers));
    upstream.pipe(response);
  });
  proxy.on("error", error => {
    if (!response.headersSent) sendJson(response, 502, { error: "Termux server unavailable: " + error.message });
    else response.destroy(error);
  });
  request.pipe(proxy);
});

server.listen(port, "127.0.0.1", () => {
  console.log("OpenCode Acode bridge listening on http://127.0.0.1:" + port);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
