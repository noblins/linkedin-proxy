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
      let resolved = false;

      res.on("data", (chunk) => {
        data += chunk.toString();
        if (resolved) return;
        const lines = data.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.substring(6));
              if (parsed.result || parsed.error) {
                resolved = true;
                res.destroy();
                resolve({ result: parsed, sessionId: sid });
                return;
              }
            } catch (e) {}
          }
        }
      });

      res.on("end", () => {
        if (resolved) return;
        const lines = data.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const parsed = JSON.parse(line.substring(6));
              resolve({ result: parsed, sessionId: sid });
              return;
            } catch (e) {}
          }
        }
        try {
          resolve({ result: JSON.parse(data), sessionId: sid });
        } catch (e) {
          resolve({ result: null, sessionId: sid, rawData: data });
        }
      });

      res.on("error", (err) => { if (!resolved) reject(err); });
    });

    req.on("error", (err) => reject(err));
    req.setTimeout(150000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(postData);
    req.end();
  });
}

function parseProfiles(mcpResult) {
  var profiles = [];
  if (!mcpResult) return profiles;

  // The mcpResult is the full JSON-RPC response: { jsonrpc, id, result: { content, structuredContent } }
  var r = mcpResult.result;
  if (!r) return profiles;

  var sc = r.structuredContent;
  var content = r.content;

  // Parse from structuredContent (preferred)
  if (sc && sc.references && sc.references.search_results) {
    var refs = sc.references.search_results;
    var searchText = (sc.sections && sc.sections.search_results) || "";

    for (var i = 0; i < refs.length; i++) {
      var ref = refs[i];
      if (ref.kind !== "person") continue;

      var name = ref.text || "";
      var linkedinUrl = ref.url ? "https://www.linkedin.com" + ref.url : "";

      var headline = "";
      var location = "";
      var company = "";
      var nameIdx = searchText.indexOf(name);
      if (nameIdx >= 0) {
        var afterName = searchText.substring(nameIdx + name.length, nameIdx + name.length + 500);
        var lines = afterName.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

        for (var j = 0; j < lines.length; j++) {
          var line = lines[j];
          if (line === "Connect" || line === "Follow" || line === "Message") break;
          if (line.match(/• \d+(st|nd|rd|th)/) || line === "•") continue;
          if (line.match(/^Current:|^Past:/)) {
            company = line;
          } else if (!headline && line.length > 3 && !line.match(/mutual connection/i)) {
            headline = line;
          } else if (!location && headline && line.length > 3 && !line.match(/mutual connection/i) && !line.match(/^Current:|^Past:/)) {
            location = line;
          }
        }
      }

      profiles.push({
        name: name,
        headline: headline,
        location: location,
        company: company,
        linkedinUrl: linkedinUrl
      });
    }
  }

  // Fallback: parse from content text blocks
  if (profiles.length === 0 && content) {
    for (var k = 0; k < content.length; k++) {
      if (content[k].type === "text" && content[k].text) {
        // Try to extract profile-like data from text
        var text = content[k].text;
        try {
          var parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            profiles = parsed;
          }
        } catch (e) {
          // Text is not JSON, try to parse as structured text
          var nameMatches = text.match(/(?:^|\n)([A-Z][a-zà-ü]+ [A-Z][a-zà-ü]+(?:\s[A-Z][a-zà-ü]+)?)/gm);
          if (nameMatches && nameMatches.length > 0) {
            profiles = [{ raw: text.substring(0, 2000) }];
          }
        }
      }
    }
  }

  return profiles;
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

      console.log("[PROXY] Search request:", { keywords, location });

      const init = await mcpRequest({
        jsonrpc: "2.0", id: "init-1", method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linkedin-proxy", version: "3.0.0" } }
      });

      console.log("[PROXY] MCP init OK, sessionId:", init.sessionId);

      const search = await mcpRequest({
        jsonrpc: "2.0", id: "search-1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, init.sessionId);

      console.log("[PROXY] MCP search raw keys:", search.result ? Object.keys(search.result) : "null");

      // Deep inspection of the response structure
      var debugInfo = {};
      if (search.result) {
        debugInfo.topKeys = Object.keys(search.result);
        if (search.result.result) {
          debugInfo.resultKeys = Object.keys(search.result.result);
          if (search.result.result.structuredContent) {
            debugInfo.scKeys = Object.keys(search.result.result.structuredContent);
            if (search.result.result.structuredContent.references) {
              debugInfo.refKeys = Object.keys(search.result.result.structuredContent.references);
            }
          }
          if (search.result.result.content) {
            debugInfo.contentLength = search.result.result.content.length;
            debugInfo.contentTypes = search.result.result.content.map(function(c) { return c.type; });
            // Include first 500 chars of first text content for debug
            for (var ci = 0; ci < search.result.result.content.length; ci++) {
              if (search.result.result.content[ci].type === "text") {
                debugInfo.firstTextPreview = search.result.result.content[ci].text.substring(0, 500);
                break;
              }
            }
          }
        }
        if (search.result.error) {
          debugInfo.error = search.result.error;
        }
      }
      if (search.rawData) {
        debugInfo.rawData = search.rawData.substring(0, 1000);
      }

      console.log("[PROXY] Debug info:", JSON.stringify(debugInfo));

      const profiles = parseProfiles(search.result);

      console.log("[PROXY] Parsed profiles count:", profiles.length);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profiles, count: profiles.length, debug: debugInfo }));
    } catch (err) {
      console.error("[PROXY] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => { console.log("LinkedIn proxy v3 (debug) running on port " + PORT); });
