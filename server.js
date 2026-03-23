const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;
const SEEN_FILE = path.join(__dirname, "seen-profiles.json");

// ─── Seen profiles (deduplication) ───
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); }
  catch (e) { return {}; }
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

    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname,
      method: "POST", headers
    }, (res) => {
      const sid = res.headers["mcp-session-id"] || "";
      let data = "";
      let resolved = false;

      res.on("data", (chunk) => {
        data += chunk.toString();
        if (resolved) return;
        for (const line of data.split("\n")) {
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
        for (const line of data.split("\n")) {
          if (line.startsWith("data: ")) {
            try {
              resolve({ result: JSON.parse(line.substring(6)), sessionId: sid });
              return;
            } catch (e) {}
          }
        }
        try { resolve({ result: JSON.parse(data), sessionId: sid }); }
        catch (e) { resolve({ result: null, sessionId: sid, rawData: data }); }
      });

      res.on("error", (err) => { if (!resolved) reject(err); });
    });

    req.on("error", reject);
    req.setTimeout(150000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(postData);
    req.end();
  });
}

async function initMcp() {
  const init = await mcpRequest({
    jsonrpc: "2.0", id: "init-1", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linkedin-proxy", version: "5.0.0" } }
  });
  return init.sessionId;
}

// ─── Parse profiles from search text ───
// Instead of relying on references (which include mutual connections),
// parse the actual search results text to identify real profiles.
function parseProfiles(mcpResult) {
  if (!mcpResult || !mcpResult.result) return [];

  var r = mcpResult.result;
  var profiles = [];

  // Get the text content (contains the full search page text)
  var fullText = "";
  if (r.content) {
    for (var i = 0; i < r.content.length; i++) {
      if (r.content[i].type === "text") {
        try {
          var parsed = JSON.parse(r.content[i].text);
          if (parsed.sections && parsed.sections.search_results) {
            fullText = parsed.sections.search_results;
          }
        } catch (e) {
          fullText = r.content[i].text;
        }
      }
    }
  }

  // Also try structuredContent
  if (!fullText && r.structuredContent && r.structuredContent.sections) {
    fullText = r.structuredContent.sections.search_results || "";
  }

  if (!fullText) return [];

  // Build a URL map from references
  var urlMap = {};
  var refs = null;
  if (r.structuredContent && r.structuredContent.references && r.structuredContent.references.search_results) {
    refs = r.structuredContent.references.search_results;
  }
  // Also check content text for references
  if (!refs && r.content) {
    for (var ci = 0; ci < r.content.length; ci++) {
      if (r.content[ci].type === "text") {
        try {
          var p = JSON.parse(r.content[ci].text);
          if (p.references && p.references.search_results) {
            refs = p.references.search_results;
          }
        } catch (e) {}
      }
    }
  }
  if (refs) {
    for (var ri = 0; ri < refs.length; ri++) {
      if (refs[ri].kind === "person" && refs[ri].text && refs[ri].url) {
        urlMap[refs[ri].text] = "https://www.linkedin.com" + refs[ri].url;
      }
    }
  }

  // Parse the search text to find real profiles
  // Pattern: real search results have a connection degree indicator (• 1er, • 2e, • 3e+)
  // Mutual connections appear as ", Name et X autres relations..."
  var lines = fullText.split("\n");
  var currentProfile = null;

  for (var li = 0; li < lines.length; li++) {
    var line = lines[li].trim();
    if (!line) continue;

    // Skip navigation/footer text
    if (line === "Modifier la recherche" || line === "Aucun résultat" ||
        line.match(/^(À propos|Accessibilité|Assistance|Conditions|Politique)/) ||
        line === "Page" || line.match(/^Suivant$/) || line.match(/^Précédent$/)) continue;

    // Connection degree indicator = confirms the previous line was a real profile name
    var degreeMatch = line.match(/^•\s*(\d+)(?:er|e|ère)$/);
    if (degreeMatch) {
      // The name was the previous non-empty line
      // currentProfile should already be set from the name line
      if (currentProfile) {
        currentProfile.degree = degreeMatch[1];
        currentProfile.confirmed = true;
      }
      continue;
    }

    // Skip mutual connection lines
    if (line.match(/relations?\s+(que\s+)?vous\s+avez\s+en\s+commun/i) ||
        line.match(/^\s*,\s*/) ||
        line.match(/^et\s+\d+\s+autres?\s+relation/i) ||
        line.match(/^\d+\s+autres?\s+relation/i)) {
      continue;
    }

    // Action buttons = end of a profile block
    if (line === "Connect" || line === "Follow" || line === "Message" ||
        line === "Se connecter" || line === "Suivre" || line === "Envoyer un message" ||
        line === "En attente") {
      if (currentProfile && currentProfile.confirmed) {
        profiles.push(currentProfile);
      }
      currentProfile = null;
      continue;
    }

    // If we have a confirmed profile, collect its details
    if (currentProfile && currentProfile.confirmed) {
      if (!currentProfile.headline && line.length > 2 &&
          !line.match(/^Current:|^Past:|^Actuel/) &&
          !line.match(/mutual connection/i) &&
          !line.match(/relation.*commun/i)) {
        currentProfile.headline = line;
      } else if (currentProfile.headline && !currentProfile.location &&
                 line.length > 2 && !line.match(/^Current:|^Past:|^Actuel/) &&
                 !line.match(/mutual/i) && !line.match(/relation.*commun/i)) {
        // Check if this looks like a location (city, region pattern)
        if (line.match(/,/) || line.match(/(Paris|Lyon|France|Île|Region|région|Area)/i) ||
            (!line.match(/^Current:|^Past:|^Actuel/) && line.length < 80)) {
          currentProfile.location = line;
        }
      }
      if (line.match(/^(Current:|Past:|Actuel\s*:)/)) {
        currentProfile.company = line;
      }
      continue;
    }

    // Potential profile name: check if next line has a degree indicator
    if (li + 1 < lines.length) {
      var nextLine = lines[li + 1].trim();
      if (nextLine.match(/^•\s*\d+(?:er|e|ère)$/)) {
        // This line is a profile name, next line confirms it
        currentProfile = {
          name: line,
          headline: "",
          location: "",
          company: "",
          linkedinUrl: urlMap[line] || "",
          confirmed: false
        };
        continue;
      }
    }

    // If the line matches a name in our URL map and isn't a known mutual connection context
    if (urlMap[line] && !currentProfile) {
      // Check surrounding context - is this a mutual connection mention?
      var prevLine = li > 0 ? lines[li - 1].trim() : "";
      var nextL = li + 1 < lines.length ? lines[li + 1].trim() : "";
      if (!prevLine.match(/,\s*$/) && !prevLine.match(/relation/i) &&
          !nextL.match(/relation.*commun/i)) {
        currentProfile = {
          name: line,
          headline: "",
          location: "",
          company: "",
          linkedinUrl: urlMap[line] || "",
          confirmed: false
        };
      }
    }
  }

  // Don't forget last profile
  if (currentProfile && currentProfile.confirmed) {
    profiles.push(currentProfile);
  }

  // Clean up profiles - remove degree and confirmed fields
  return profiles.map(function(p) {
    return {
      name: p.name,
      headline: p.headline,
      location: p.location,
      company: p.company,
      linkedinUrl: p.linkedinUrl
    };
  });
}

// ─── Deduplication ───
function deduplicateProfiles(profiles, searchKey) {
  var seen = loadSeen();
  var newProfiles = [];
  var duplicates = [];

  for (var i = 0; i < profiles.length; i++) {
    var p = profiles[i];
    var key = p.linkedinUrl || p.name || "";
    if (!key) { newProfiles.push(p); continue; }
    if (seen[key]) {
      duplicates.push(p.name || key);
    } else {
      seen[key] = { name: p.name, search: searchKey, date: new Date().toISOString() };
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

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "5.0.0" }));
    return;
  }

  // ─── GET /tools ───
  if (req.method === "GET" && req.url === "/tools") {
    try {
      const sid = await initMcp();
      const tools = await mcpRequest(
        { jsonrpc: "2.0", id: "t1", method: "tools/list", params: {} }, sid
      );
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tools.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── POST /profile ───
  if (req.method === "POST" && req.url === "/profile") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const params = JSON.parse(body);
      const profileUrl = params.url || "";
      console.log("[PROXY] Profile request:", profileUrl);
      const sid = await initMcp();
      const profile = await mcpRequest({
        jsonrpc: "2.0", id: "p1", method: "tools/call",
        params: { name: "get_profile", arguments: { url: profileUrl } }
      }, sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(profile.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── POST /search ───
  if (req.method === "POST" && req.url === "/search") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const params = JSON.parse(body);
      const keywords = params.keywords || "";
      const location = params.location || "";
      const limit = parseInt(params.limit) || 10;
      const deduplicate = params.deduplicate !== false;

      console.log("[PROXY] Search:", { keywords, location, limit, deduplicate });

      const sid = await initMcp();
      const search = await mcpRequest({
        jsonrpc: "2.0", id: "s1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, sid);

      var allProfiles = parseProfiles(search.result);
      console.log("[PROXY] Parsed:", allProfiles.length, "profiles");

      // Deduplication
      var duplicatesSkipped = [];
      var duplicatesCount = 0;
      if (deduplicate && allProfiles.length > 0) {
        var dedup = deduplicateProfiles(allProfiles, keywords + " | " + location);
        duplicatesSkipped = dedup.duplicates;
        duplicatesCount = dedup.duplicates.length;
        allProfiles = dedup.newProfiles;
      }

      // Apply limit
      var limited = allProfiles.slice(0, limit);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        profiles: limited,
        count: limited.length,
        totalFound: allProfiles.length + duplicatesCount,
        duplicatesSkipped: duplicatesSkipped,
        duplicatesCount: duplicatesCount
      }));
    } catch (err) {
      console.error("[PROXY] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── GET /seen ───
  if (req.method === "GET" && req.url === "/seen") {
    var seen = loadSeen();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: Object.keys(seen).length, profiles: seen }, null, 2));
    return;
  }

  // ─── DELETE /seen ───
  if (req.method === "DELETE" && req.url === "/seen") {
    saveSeen({});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Seen profiles cleared" }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => { console.log("LinkedIn proxy v5 running on port " + PORT); });
