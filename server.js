const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;
const SEEN_FILE = path.join(__dirname, "seen-profiles.json");

// ─── Seen profiles (deduplication) ───
function loadSeen() {
  try {
    return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

// ─── MCP communication ───
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

// ─── Initialize MCP session ───
async function initMcp() {
  const init = await mcpRequest({
    jsonrpc: "2.0", id: "init-1", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linkedin-proxy", version: "4.0.0" } }
  });
  return init.sessionId;
}

// ─── Parse profiles from search results ───
function parseProfiles(mcpResult) {
  var profiles = [];
  if (!mcpResult) return profiles;

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

  // Fallback: parse from content text (JSON in text field)
  if (profiles.length === 0 && content) {
    for (var k = 0; k < content.length; k++) {
      if (content[k].type === "text" && content[k].text) {
        try {
          var parsed = JSON.parse(content[k].text);
          if (parsed.sections && parsed.sections.search_results) {
            // The text content is the same structure as structuredContent
            profiles = [{ raw: content[k].text.substring(0, 2000) }];
          } else if (Array.isArray(parsed)) {
            profiles = parsed;
          }
        } catch (e) {
          profiles = [{ raw: content[k].text.substring(0, 2000) }];
        }
      }
    }
  }

  return profiles;
}

// ─── Deduplication ───
function deduplicateProfiles(profiles, searchKey) {
  var seen = loadSeen();
  var newProfiles = [];
  var duplicates = [];

  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    // Use LinkedIn URL as unique key, fallback to name
    var key = p.linkedinUrl || p.name || "";
    if (!key) { newProfiles.push(p); continue; }

    if (seen[key]) {
      duplicates.push(p.name || key);
    } else {
      seen[key] = {
        name: p.name,
        firstSeenSearch: searchKey,
        firstSeenDate: new Date().toISOString()
      };
      newProfiles.push(p);
    }
  }

  saveSeen(seen);
  return { newProfiles, duplicates };
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // ─── GET /health ───
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "4.0.0" }));
    return;
  }

  // ─── GET /tools — List MCP tools ───
  if (req.method === "GET" && req.url === "/tools") {
    try {
      const sessionId = await initMcp();
      const toolsList = await mcpRequest({
        jsonrpc: "2.0", id: "tools-1", method: "tools/list", params: {}
      }, sessionId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(toolsList.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── POST /profile — Get a LinkedIn profile ───
  if (req.method === "POST" && req.url === "/profile") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const params = JSON.parse(body);
      const profileUrl = params.url || "";

      console.log("[PROXY] Profile request:", profileUrl);

      const sessionId = await initMcp();
      const profile = await mcpRequest({
        jsonrpc: "2.0", id: "profile-1", method: "tools/call",
        params: { name: "get_profile", arguments: { url: profileUrl } }
      }, sessionId);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(profile.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── POST /search — Search LinkedIn profiles ───
  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const params = JSON.parse(body);
      const keywords = params.keywords || "";
      const location = params.location || "";
      const deduplicate = params.deduplicate !== false; // default: true

      console.log("[PROXY] Search request:", { keywords, location, deduplicate });

      const sessionId = await initMcp();

      console.log("[PROXY] MCP init OK, sessionId:", sessionId);

      const search = await mcpRequest({
        jsonrpc: "2.0", id: "search-1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, sessionId);

      // Debug info
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
            for (var ci = 0; ci < search.result.result.content.length; ci++) {
              if (search.result.result.content[ci].type === "text") {
                debugInfo.firstTextPreview = search.result.result.content[ci].text.substring(0, 500);
                break;
              }
            }
          }
        }
      }

      var allProfiles = parseProfiles(search.result);
      console.log("[PROXY] Parsed profiles count:", allProfiles.length);

      // Apply deduplication
      var result;
      if (deduplicate && allProfiles.length > 0) {
        var searchKey = keywords + " | " + location;
        var dedup = deduplicateProfiles(allProfiles, searchKey);
        result = {
          profiles: dedup.newProfiles,
          count: dedup.newProfiles.length,
          duplicatesSkipped: dedup.duplicates,
          duplicatesCount: dedup.duplicates.length,
          totalFound: allProfiles.length,
          debug: debugInfo
        };
        console.log("[PROXY] After dedup:", dedup.newProfiles.length, "new,", dedup.duplicates.length, "duplicates");
      } else {
        result = { profiles: allProfiles, count: allProfiles.length, debug: debugInfo };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error("[PROXY] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── GET /seen — View seen profiles ───
  if (req.method === "GET" && req.url === "/seen") {
    var seen = loadSeen();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: Object.keys(seen).length, profiles: seen }, null, 2));
    return;
  }

  // ─── DELETE /seen — Clear seen profiles ───
  if (req.method === "DELETE" && req.url === "/seen") {
    saveSeen({});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Seen profiles cleared" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => { console.log("LinkedIn proxy v4 running on port " + PORT); });
