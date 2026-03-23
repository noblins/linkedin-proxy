const http = require("http");
const https = require("https");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;

function mcpRequest(body, sessionId) {
  return new Promise((resolve, reject) => {
    const url = new URL(MCP_URL);
    const postData = JSON.stringify(body);

    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Content-Length": Buffer.byteLength(postData)
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: "POST",
      headers
    };

    const req = https.request(options, (res) => {
      const sid = res.headers["mcp-session-id"] || "";
      let data = "";

      res.on("data", (chunk) => {
        data += chunk.toString();
        const lines = data.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.substring(6));
              res.destroy();
              resolve({ result: parsed, sessionId: sid });
              return;
            } catch (e) {}
          }
        }
        try {
          const parsed = JSON.parse(data);
          res.destroy();
          resolve({ result: parsed, sessionId: sid });
        } catch (e) {}
      });

      res.on("end", () => {
        const lines = data.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              resolve({ result: JSON.parse(line.substring(6)), sessionId: sid });
              return;
            } catch (e) {}
          }
        }
        try {
          resolve({ result: JSON.parse(data), sessionId: sid });
        } catch (e) {
          resolve({ result: null, sessionId: sid, raw: data });
        }
      });

      res.on("error", (err) => reject(err));
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(90000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(postData);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const params = JSON.parse(body);
      const keywords = params.keywords || "";
      const location = params.location || "";

      const init = await mcpRequest({
        jsonrpc: "2.0", id: "init-1", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linkedin-proxy", version: "1.0.0" } }
      });

      const search = await mcpRequest({
        jsonrpc: "2.0", id: "search-1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, init.sessionId);

      let profiles = [];
      const sr = search.result;
      if (sr && sr.result && sr.result.content) {
        for (const item of sr.result.content) {
          if (item.type === "text") {
            try { profiles = JSON.parse(item.text); } catch (e) { profiles = [{ raw: item.text }]; }
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profiles, raw: sr }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message, stack: err.stack }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => { console.log("LinkedIn proxy running on port " + PORT); });
