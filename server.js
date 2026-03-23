const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;
const SEEN_FILE = path.join(__dirname, "seen-profiles.json");
const PROFILE_DELAY_MS = 4000; // delay between profile visits to avoid LinkedIn detection

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
    req.setTimeout(180000, () => { req.destroy(); reject(new Error("timeout")); });
    req.write(postData);
    req.end();
  });
}

async function initMcp() {
  const init = await mcpRequest({
    jsonrpc: "2.0", id: "init-1", method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "linkedin-proxy", version: "6.0.0" } }
  });
  return init.sessionId;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Extract text from MCP response ───
function extractText(mcpResult) {
  if (!mcpResult || !mcpResult.result) return "";
  var r = mcpResult.result;

  // Try structuredContent first
  if (r.structuredContent && r.structuredContent.sections) {
    return Object.values(r.structuredContent.sections).join("\n\n");
  }

  // Try content text
  if (r.content) {
    for (var i = 0; i < r.content.length; i++) {
      if (r.content[i].type === "text") {
        try {
          var parsed = JSON.parse(r.content[i].text);
          if (parsed.sections) {
            return Object.values(parsed.sections).join("\n\n");
          }
        } catch (e) {
          return r.content[i].text;
        }
      }
    }
  }
  return "";
}

// ─── Extract references (URL map) from MCP response ───
function extractRefs(mcpResult) {
  var urlMap = {};
  if (!mcpResult || !mcpResult.result) return urlMap;
  var r = mcpResult.result;

  var refs = null;
  if (r.structuredContent && r.structuredContent.references && r.structuredContent.references.search_results) {
    refs = r.structuredContent.references.search_results;
  }
  if (!refs && r.content) {
    for (var i = 0; i < r.content.length; i++) {
      if (r.content[i].type === "text") {
        try {
          var p = JSON.parse(r.content[i].text);
          if (p.references && p.references.search_results) refs = p.references.search_results;
        } catch (e) {}
      }
    }
  }
  if (refs) {
    for (var j = 0; j < refs.length; j++) {
      if (refs[j].kind === "person" && refs[j].text && refs[j].url) {
        urlMap[refs[j].text] = refs[j].url; // /in/username
      }
    }
  }
  return urlMap;
}

// ─── Parse search results into basic profiles ───
function parseSearchResults(mcpResult) {
  var text = extractText(mcpResult);
  var urlMap = extractRefs(mcpResult);

  if (!text) return [];

  var profiles = [];
  var lines = text.split("\n");
  var currentProfile = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;

    // Skip footer
    if (line.match(/^(À propos|Accessibilité|Assistance|Conditions|Politique|Modifier la recherche|Aucun résultat|Page\s|Suivant|Précédent)/)) continue;

    // Connection degree = confirms a real profile
    var degreeMatch = line.match(/^•\s*(\d+)(?:er|e|ère)$/);
    if (degreeMatch) {
      if (currentProfile) {
        currentProfile.confirmed = true;
      }
      continue;
    }

    // Mutual connection lines = skip
    if (line.match(/relation.*commun/i) || line.match(/^\s*,\s*/) ||
        line.match(/^et\s+\d+\s+autre/i) || line.match(/^\d+\s+autre.*relation/i)) {
      continue;
    }

    // Action buttons = end of profile block
    if (line === "Connect" || line === "Follow" || line === "Message" ||
        line === "Se connecter" || line === "Suivre" || line === "Envoyer un message" ||
        line === "En attente") {
      if (currentProfile && currentProfile.confirmed) {
        profiles.push(currentProfile);
      }
      currentProfile = null;
      continue;
    }

    // Collect details for confirmed profile
    if (currentProfile && currentProfile.confirmed) {
      if (!currentProfile.headline && line.length > 2 &&
          !line.match(/^Current:|^Past:|^Actuel/) && !line.match(/relation.*commun/i)) {
        currentProfile.headline = line;
      } else if (currentProfile.headline && !currentProfile.location && line.length > 2 &&
                 !line.match(/^Current:|^Past:|^Actuel/) && !line.match(/relation/i)) {
        currentProfile.location = line;
      }
      if (line.match(/^(Current:|Past:|Actuel\s*:)/)) {
        currentProfile.company = line;
      }
      continue;
    }

    // Check if next line has degree indicator = this line is a name
    if (i + 1 < lines.length && lines[i + 1].trim().match(/^•\s*\d+(?:er|e|ère)$/)) {
      var linkedinPath = urlMap[line] || "";
      var username = linkedinPath.replace(/^\/in\//, "").replace(/\/$/, "");
      currentProfile = {
        name: line,
        headline: "",
        location: "",
        company: "",
        linkedinUrl: linkedinPath ? "https://www.linkedin.com" + linkedinPath : "",
        username: username,
        confirmed: false
      };
    }
  }

  // Last profile
  if (currentProfile && currentProfile.confirmed) {
    profiles.push(currentProfile);
  }

  return profiles;
}

// ─── Get detailed profile info ───
async function getProfileDetail(username, sessionId) {
  try {
    var resp = await mcpRequest({
      jsonrpc: "2.0", id: "prof-" + username, method: "tools/call",
      params: { name: "get_person_profile", arguments: { linkedin_username: username } }
    }, sessionId);

    var text = extractText(resp.result);
    var lower = text.toLowerCase();

    // Detect Open to Work
    var openToWork = lower.includes("open to work") ||
                     lower.includes("disponible") ||
                     lower.includes("ouvert aux opportunit") ||
                     lower.includes("#opentowork");

    // Extract headline from profile (first meaningful line after name)
    var profileHeadline = "";
    var profileLocation = "";
    var profileLines = text.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });

    // LinkedIn profile text usually has: Name, headline, location, connections info
    // Look for patterns
    for (var i = 0; i < Math.min(profileLines.length, 15); i++) {
      var pl = profileLines[i];
      // Skip name, buttons, connection counts
      if (pl.match(/^(Se connecter|Connect|Follow|Suivre|Message|Envoyer|Plus$|\.\.\.)/)) continue;
      if (pl.match(/^\d+\s+(relation|connection|follower|abonné)/i)) continue;
      if (pl.match(/^(Coordonnées|Contact info)/i)) continue;

      // Location patterns (city, region)
      if (!profileLocation && (pl.match(/(Paris|Lyon|Marseille|France|Île-de-France|Nantes|Toulouse|Bordeaux|Lille|région|Area|Greater)/i))) {
        // Make sure it's not a headline
        if (pl.length < 80 && !pl.match(/(chez|at|@)/i)) {
          profileLocation = pl;
          continue;
        }
      }

      // Headline = first substantial text that's not navigation
      if (!profileHeadline && pl.length > 5 && !pl.match(/^(Accueil|Home|Mon réseau|Emplois|Jobs|Notifications|Messagerie)/) &&
          i > 0) {
        profileHeadline = pl;
      }
    }

    return {
      openToWork: openToWork,
      headline: profileHeadline,
      location: profileLocation,
      rawPreview: text.substring(0, 500)
    };
  } catch (err) {
    console.error("[PROXY] Profile error for", username, ":", err.message);
    return { openToWork: false, headline: "", location: "", error: err.message };
  }
}

// ─── Location matching ───
function locationMatches(profileLocation, requestedLocation) {
  if (!requestedLocation || !profileLocation) return true; // no filter = accept all

  var req = requestedLocation.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  var prof = profileLocation.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  // Map common aliases
  var aliases = {
    "paris": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "ile-de-france": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "ile de france": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "lyon": ["lyon", "rhone-alpes", "auvergne-rhone-alpes", "rhone"],
    "marseille": ["marseille", "bouches-du-rhone", "provence", "paca"],
    "toulouse": ["toulouse", "haute-garonne", "occitanie"],
    "bordeaux": ["bordeaux", "gironde", "nouvelle-aquitaine"],
    "lille": ["lille", "nord", "hauts-de-france"],
    "nantes": ["nantes", "loire-atlantique", "pays de la loire"],
    "france": ["france"]
  };

  // Check if any alias of the requested location appears in the profile location
  var reqAliases = aliases[req] || [req];
  for (var i = 0; i < reqAliases.length; i++) {
    if (prof.includes(reqAliases[i])) return true;
  }

  // Direct substring check
  if (prof.includes(req) || req.includes(prof)) return true;

  return false;
}

// ─── Must-have keyword matching ───
function matchesMustHave(profile, mustHave) {
  if (!mustHave) return true;

  var keywords = mustHave.toLowerCase().split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var searchIn = (profile.headline + " " + profile.company + " " + (profile.detailedHeadline || "")).toLowerCase();

  var matchCount = 0;
  for (var i = 0; i < keywords.length; i++) {
    if (searchIn.includes(keywords[i])) matchCount++;
  }

  // At least half the keywords should match
  return matchCount >= Math.ceil(keywords.length / 2);
}

// ─── HTTP Server ───
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "6.0.0" }));
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

  // ─── POST /profile (test single profile) ───
  if (req.method === "POST" && req.url === "/profile") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const params = JSON.parse(body);
      const username = params.username || "";
      console.log("[PROXY] Profile request:", username);
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
      const keywords = params.keywords || "";      // poste only
      const location = params.location || "";
      const mustHave = params.mustHave || "";       // for post-filtering
      const limit = parseInt(params.limit) || 5;
      const deduplicate = params.deduplicate !== false;
      const enrichProfiles = params.enrich !== false; // default: true

      console.log("[PROXY] Search:", { keywords, location, mustHave, limit, deduplicate, enrichProfiles });

      const sid = await initMcp();

      // Step 1: Search
      const search = await mcpRequest({
        jsonrpc: "2.0", id: "s1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords, location } }
      }, sid);

      var searchProfiles = parseSearchResults(search.result);
      console.log("[PROXY] Search returned:", searchProfiles.length, "profiles");

      // Step 2: Deduplication
      var duplicatesSkipped = [];
      if (deduplicate) {
        var seen = loadSeen();
        var fresh = [];
        for (var i = 0; i < searchProfiles.length; i++) {
          var key = searchProfiles[i].linkedinUrl || searchProfiles[i].name;
          if (seen[key]) {
            duplicatesSkipped.push(searchProfiles[i].name);
          } else {
            fresh.push(searchProfiles[i]);
          }
        }
        searchProfiles = fresh;
      }

      // Step 3: Enrich each profile with get_person_profile
      var enrichedProfiles = [];
      if (enrichProfiles && searchProfiles.length > 0) {
        // Enrich more than limit to account for filtering
        var toEnrich = searchProfiles.slice(0, Math.min(searchProfiles.length, limit + 5));

        for (var j = 0; j < toEnrich.length; j++) {
          var prof = toEnrich[j];
          if (!prof.username) continue;

          console.log("[PROXY] Enriching profile", j + 1, "/", toEnrich.length, ":", prof.username);

          if (j > 0) await sleep(PROFILE_DELAY_MS);

          var detail = await getProfileDetail(prof.username, sid);

          var enriched = {
            name: prof.name,
            headline: detail.headline || prof.headline,
            location: detail.location || prof.location,
            company: prof.company,
            linkedinUrl: prof.linkedinUrl,
            openToWork: detail.openToWork,
            username: prof.username
          };

          // Filter by location
          if (location && !locationMatches(enriched.location, location)) {
            console.log("[PROXY] Filtered out (location):", enriched.name, "->", enriched.location);
            continue;
          }

          // Filter by mustHave
          if (mustHave && !matchesMustHave(enriched, mustHave)) {
            console.log("[PROXY] Filtered out (mustHave):", enriched.name);
            continue;
          }

          enrichedProfiles.push(enriched);

          // Stop if we have enough
          if (enrichedProfiles.length >= limit) break;
        }
      } else {
        // No enrichment, just filter on search data
        for (var k = 0; k < searchProfiles.length; k++) {
          var sp = searchProfiles[k];
          if (location && !locationMatches(sp.location, location)) continue;
          enrichedProfiles.push({
            name: sp.name,
            headline: sp.headline,
            location: sp.location,
            company: sp.company,
            linkedinUrl: sp.linkedinUrl,
            openToWork: null, // unknown without enrichment
            username: sp.username
          });
          if (enrichedProfiles.length >= limit) break;
        }
      }

      // Save to seen
      if (deduplicate) {
        var seen = loadSeen();
        for (var s = 0; s < enrichedProfiles.length; s++) {
          var skey = enrichedProfiles[s].linkedinUrl || enrichedProfiles[s].name;
          seen[skey] = {
            name: enrichedProfiles[s].name,
            search: keywords + " | " + location,
            date: new Date().toISOString()
          };
        }
        saveSeen(seen);
      }

      // Clean response (remove username)
      var finalProfiles = enrichedProfiles.map(function(p) {
        return {
          name: p.name,
          headline: p.headline,
          location: p.location,
          company: p.company,
          linkedinUrl: p.linkedinUrl,
          openToWork: p.openToWork
        };
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        profiles: finalProfiles,
        count: finalProfiles.length,
        duplicatesSkipped: duplicatesSkipped,
        duplicatesCount: duplicatesSkipped.length,
        searchResultsTotal: searchProfiles.length + duplicatesSkipped.length
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

server.listen(PORT, () => { console.log("LinkedIn proxy v6 running on port " + PORT); });
