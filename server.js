const http = require("http");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;

async function mcpRequest(body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  const sid = res.headers.get("mcp-session-id") || "";
  const text = await res.text();

  // Parse SSE or JSON
  let result = null;
  try {
    result = JSON.parse(text);
  } catch (e) {
    // Try SSE parsing
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          result = JSON.parse(line.substring(6));
        } catch (e2) {}
      }
    }
  }
  return { result, sessionId: sid };
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

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

      // Step 1: Initialize MCP session
      const init = await mcpRequest({
        jsonrpc: "2.0",
        id: "init-1",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "linkedin-proxy", version: "1.0.0" }
        }
      });

      // Step 2: Search people
      const search = await mcpRequest({
        jsonrpc: "2.0",
        id: "search-1",
        method: "tools/call",
        params: {
          name: "search_people",
          arguments: { keywords, location }
        }
      }, init.sessionId);

      // Extract profiles from MCP response
      let profiles = [];
      if (search.result && search.result.result && search.result.result.content) {
        for (const item of search.result.result.content) {
          if (item.type === "text") {
            try {
              profiles = JSON.parse(item.text);
            } catch (e) {
              profiles = [{ raw: item.text }];
            }
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profiles, raw: search.result }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log("LinkedIn proxy running on port " + PORT);
});
