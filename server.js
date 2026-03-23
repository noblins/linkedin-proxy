const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;
const SEEN_FILE = path.join(__dirname, "seen-profiles.json");
const PROFILE_DELAY_MS = 4000;

// ─── Seen profiles ───
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); } catch (e) { return {}; }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

// ─── MCP request ───
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
      hostname: url.hostname, port: 443, path: url.pathname, method: "POST", headers
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
                resolved = true; res.destroy();
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
            try { resolve({ result: JSON.parse(line.substring(6)), sessionId: sid }); return; } catch (e) {}
          }
        }
        try { resolve({ result: JSON.parse(data), sessionId: sid }); }
        catch (e) { resolve({ result: null, sessionId: sid, rawData: data }); }
      });

      res.on("error", (err) => { if (!resolved) reject(err); });
    });
    req.on("error", reject);
    req.setTimeout(180000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(postData);
    req.end();
  });
}

async function initMcp() {
  const r = await mcpRequest({
    jsonrpc: "2.0", id: "init", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "proxy", version: "7.0" } }
  });
  return r.sessionId;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Extract person references from MCP result ───
// This is the SIMPLE approach that worked in v3 — just grab all person refs
function extractPersonRefs(mcpResult) {
  if (!mcpResult || !mcpResult.result) return [];
  var r = mcpResult.result;
  var refs = null;

  // Try structuredContent.references
  if (r.structuredContent && r.structuredContent.references) {
    var allRefs = r.structuredContent.references;
    // references can be { search_results: [...] } or direct array
    if (allRefs.search_results) refs = allRefs.search_results;
    else if (Array.isArray(allRefs)) refs = allRefs;
  }

  // Fallback: try content text (JSON)
  if (!refs && r.content) {
    for (var i = 0; i < r.content.length; i++) {
      if (r.content[i].type === "text") {
        try {
          var p = JSON.parse(r.content[i].text);
          if (p.references) {
            if (p.references.search_results) refs = p.references.search_results;
            else if (Array.isArray(p.references)) refs = p.references;
          }
        } catch (e) {}
      }
    }
  }

  if (!refs) return [];

  // Filter to person-kind refs with URLs
  var persons = [];
  var seenUrls = {};
  for (var j = 0; j < refs.length; j++) {
    var ref = refs[j];
    if (ref.kind === "person" && ref.url && ref.text) {
      // Dedupe by URL within same search
      if (seenUrls[ref.url]) continue;
      seenUrls[ref.url] = true;

      var username = ref.url.replace(/^\/in\//, "").replace(/\/$/, "");
      persons.push({
        name: ref.text,
        linkedinUrl: "https://www.linkedin.com" + ref.url,
        username: username
      });
    }
  }

  return persons;
}

// ─── Get detailed profile ───
async function getProfileDetail(username, sessionId) {
  try {
    var resp = await mcpRequest({
      jsonrpc: "2.0", id: "p-" + username, method: "tools/call",
      params: { name: "get_person_profile", arguments: { linkedin_username: username } }
    }, sessionId);

    // Extract all text from response
    var text = "";
    var r = resp.result ? resp.result.result : null;
    if (r) {
      if (r.structuredContent && r.structuredContent.sections) {
        text = Object.values(r.structuredContent.sections).join("\n\n");
      } else if (r.content) {
        for (var i = 0; i < r.content.length; i++) {
          if (r.content[i].type === "text") {
            try {
              var parsed = JSON.parse(r.content[i].text);
              if (parsed.sections) text = Object.values(parsed.sections).join("\n\n");
              else text = r.content[i].text;
            } catch (e) {
              text = r.content[i].text;
            }
          }
        }
      }
    }

    var lower = text.toLowerCase();

    // Detect Open to Work
    var openToWork = lower.includes("open to work") ||
                     lower.includes("disponible pour") ||
                     lower.includes("ouvert aux opportunit") ||
                     lower.includes("#opentowork") ||
                     lower.includes("actively seeking");

    // Parse profile info from text lines
    var lines = text.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var headline = "";
    var location = "";

    // Skip patterns that are NOT headlines
    function isSkipLine(line) {
      // Navigation and buttons
      if (line.match(/^(Se connecter|Connect|Follow|Suivre|Message|Envoyer un message|Plus|\.{3}|Accueil|Home|Mon réseau|Emplois|Jobs|Notifications|Messagerie|Recherche|Premium)$/i)) return true;
      // Connection degree (French and English)
      if (line.match(/relation\s+de\s+\d+e?\s+niveau/i)) return true;
      if (line.match(/^\d+(st|nd|rd|th)\s+(degree\s+)?connection/i)) return true;
      if (line.match(/^relation\s+de/i)) return true;
      if (line.match(/^•\s*\d+(er|e|ère)$/)) return true;
      // Connection/follower counts
      if (line.match(/^\d+\s+(relation|connection|follower|abonné|contact)/i)) return true;
      if (line.match(/^\+?\d+\s+(relation|connection)/i)) return true;
      if (line.match(/^plus de \d+/i)) return true;
      // UI elements
      if (line.match(/^(Coordonnées|Contact info|Voir le profil|Open to work|Disponible)/i)) return true;
      if (line.match(/^(Afficher|Voir|Show|Modifier|Edit|Ajouter)\s/i)) return true;
      if (line.match(/^(En savoir plus|See more|Voir plus)/i)) return true;
      if (line.match(/^(Expérience|Experience|Formation|Education|Compétences|Skills|Licences|Certifications|Langues|Languages|Centres d'intérêt|Interests|Recommandations|Recommendations|Activité|Activity)$/i)) return true;
      // Very short lines (likely UI artifacts)
      if (line.length <= 3) return true;
      // Lines that are just a name repeated
      if (line.match(/^(M\.|Mme|Mr|Mrs|Dr|Prof)\.?\s/i) && line.length < 20) return true;
      return false;
    }

    // Look for headline and location
    for (var li = 1; li < Math.min(lines.length, 25); li++) {
      var line = lines[li];
      if (isSkipLine(line)) continue;

      // Headline = first substantial text after name (must be > 10 chars typically)
      if (!headline && line.length > 5) {
        headline = line;
        continue;
      }

      // Location = after headline, usually a city/region
      if (headline && !location && line.length > 2 && line.length < 100) {
        if (!line.match(/^\d/) && !line.match(/^(Current|Past|Actuel|Formation|Education)/i)) {
          location = line;
          break;
        }
      }
    }

    console.log("[PROXY] Profile parsed:", username, "-> headline:", headline.substring(0, 80), "| location:", location, "| otw:", openToWork);

    return {
      openToWork: openToWork,
      headline: headline,
      location: location
    };
  } catch (err) {
    console.error("[PROXY] Profile error for", username, ":", err.message);
    return { openToWork: false, headline: "", location: "", error: err.message };
  }
}

// ─── Location matching ───
function locationMatches(profileLoc, requestedLoc) {
  if (!requestedLoc) return true;
  if (!profileLoc) return true; // can't filter without data

  var req = requestedLoc.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  var prof = profileLoc.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  var aliases = {
    "paris": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris", "75"],
    "ile-de-france": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "ile de france": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "lyon": ["lyon", "rhone", "auvergne-rhone-alpes"],
    "marseille": ["marseille", "bouches-du-rhone", "provence", "paca"],
    "toulouse": ["toulouse", "haute-garonne", "occitanie"],
    "bordeaux": ["bordeaux", "gironde", "nouvelle-aquitaine"],
    "lille": ["lille", "nord", "hauts-de-france"],
    "nantes": ["nantes", "loire-atlantique", "pays de la loire"],
    "france": ["france"]
  };

  var reqAliases = aliases[req] || [req];
  for (var i = 0; i < reqAliases.length; i++) {
    if (prof.includes(reqAliases[i])) return true;
  }
  return prof.includes(req) || req.includes(prof);
}

// ─── Keyword matching (poste) — STRICT: all keywords must match ───
function matchesPoste(headline, poste) {
  if (!poste) return true;
  // Split poste into individual words, keep only meaningful ones (3+ chars)
  var kws = poste.toLowerCase().split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var hay = headline.toLowerCase();
  for (var i = 0; i < kws.length; i++) {
    if (!hay.includes(kws[i])) return false; // ALL keywords must match
  }
  return true;
}

// ─── Must-have matching — at least half must match ───
function matchesMustHave(headline, mustHave) {
  if (!mustHave) return true;
  var kws = mustHave.toLowerCase().split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var hay = headline.toLowerCase();
  var hits = 0;
  for (var i = 0; i < kws.length; i++) {
    if (hay.includes(kws[i])) hits++;
  }
  return hits >= Math.ceil(kws.length / 2);
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "7.0.0" }));
    return;
  }

  // ─── GET /tools ───
  if (req.method === "GET" && req.url === "/tools") {
    try {
      const sid = await initMcp();
      const tools = await mcpRequest({ jsonrpc: "2.0", id: "t1", method: "tools/list", params: {} }, sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tools.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ─── POST /profile (test) ───
  if (req.method === "POST" && req.url === "/profile") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const params = JSON.parse(body);
      const username = params.username || "";
      const sid = await initMcp();
      const detail = await getProfileDetail(username, sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(detail, null, 2));
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
      const mustHave = params.mustHave || "";
      const limit = parseInt(params.limit) || 5;
      const deduplicate = params.deduplicate !== false;
      const enrich = params.enrich !== false;

      console.log("[PROXY] Search:", JSON.stringify({ keywords, location, mustHave, limit, enrich }));

      const sid = await initMcp();

      // Step 1: Search LinkedIn
      const search = await mcpRequest({
        jsonrpc: "2.0", id: "s1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, sid);

      // Step 2: Extract person references (simple, proven approach)
      var candidates = extractPersonRefs(search.result);
      console.log("[PROXY] Found", candidates.length, "person refs");

      // Step 3: Deduplication
      var seen = deduplicate ? loadSeen() : {};
      var duplicatesSkipped = [];
      var fresh = [];
      for (var i = 0; i < candidates.length; i++) {
        var key = candidates[i].linkedinUrl;
        if (deduplicate && seen[key]) {
          duplicatesSkipped.push(candidates[i].name);
        } else {
          fresh.push(candidates[i]);
        }
      }

      // Step 4: Enrich profiles (visit each one)
      var results = [];
      var filtered = { location: [], mustHave: [] };

      if (enrich && fresh.length > 0) {
        // Process more than limit to account for filtering
        var toProcess = fresh.slice(0, Math.min(fresh.length, limit * 3, 15));

        for (var j = 0; j < toProcess.length; j++) {
          if (results.length >= limit) break;

          var c = toProcess[j];
          if (!c.username) continue;

          console.log("[PROXY] Enriching", j + 1, "/", toProcess.length, ":", c.name);
          if (j > 0) await sleep(PROFILE_DELAY_MS);

          var detail = await getProfileDetail(c.username, sid);

          // Use enriched headline if available, otherwise keep search headline
          var finalHeadline = detail.headline || "";
          var finalLocation = detail.location || "";

          // Filter by poste keywords (STRICT — all must match)
          if (keywords && finalHeadline && !matchesPoste(finalHeadline, keywords)) {
            console.log("[PROXY] Skip (poste):", c.name, "->", finalHeadline);
            filtered.poste = filtered.poste || [];
            filtered.poste.push(c.name + " (" + finalHeadline.substring(0, 60) + ")");
            continue;
          }

          // Filter by location
          if (location && finalLocation && !locationMatches(finalLocation, location)) {
            console.log("[PROXY] Skip (location):", c.name, "->", finalLocation);
            filtered.location.push(c.name);
            continue;
          }

          // Filter by mustHave (softer — at least half)
          if (mustHave && finalHeadline && !matchesMustHave(finalHeadline, mustHave)) {
            console.log("[PROXY] Skip (mustHave):", c.name, "->", finalHeadline);
            filtered.mustHave.push(c.name);
            continue;
          }

          results.push({
            name: c.name,
            headline: finalHeadline,
            location: finalLocation,
            linkedinUrl: c.linkedinUrl,
            openToWork: detail.openToWork
          });
        }
      } else {
        // No enrichment - return raw search results
        results = fresh.slice(0, limit).map(function(c) {
          return {
            name: c.name,
            headline: "",
            location: "",
            linkedinUrl: c.linkedinUrl,
            openToWork: null
          };
        });
      }

      // Save to seen
      if (deduplicate) {
        for (var s = 0; s < results.length; s++) {
          seen[results[s].linkedinUrl] = {
            name: results[s].name,
            search: keywords,
            date: new Date().toISOString()
          };
        }
        saveSeen(seen);
      }

      console.log("[PROXY] Final:", results.length, "profiles");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        profiles: results,
        count: results.length,
        totalCandidates: candidates.length,
        duplicatesSkipped: duplicatesSkipped,
        duplicatesCount: duplicatesSkipped.length,
        filteredOut: filtered
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
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadSeen(), null, 2));
    return;
  }

  // ─── DELETE /seen ───
  if (req.method === "DELETE" && req.url === "/seen") {
    saveSeen({});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "cleared" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => console.log("LinkedIn proxy v7 on port " + PORT));
