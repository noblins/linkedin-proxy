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

    // Get the person's name from first line to skip it if repeated
    var personName = lines.length > 0 ? norm(lines[0]) : "";

    // Look for headline and location
    for (var li = 1; li < Math.min(lines.length, 25); li++) {
      var line = lines[li];
      if (isSkipLine(line)) continue;

      // Skip if line is just the person's name repeated
      if (norm(line) === personName) continue;
      // Skip if line is a subset of the name or vice versa
      if (personName && norm(line).length > 3 &&
          (personName.includes(norm(line)) || norm(line).includes(personName))) continue;

      // Headline = first substantial text after name
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

// ─── Normalize text (lowercase, strip accents) ───
function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ─── Root of a word (strip common French/English suffixes) ───
function root(word) {
  var w = norm(word);
  // Remove common endings to get root: architecte→architect, developer→develop
  w = w.replace(/(eur|eure|euse|trice|iste|tion|ment|ing|tion|sion|ance|ence|able|ible|ment)$/, "");
  // If word is long enough, also try trimming last 1-2 chars for fuzzy
  if (w.length > 6) return w.substring(0, w.length); // keep full root
  return w;
}

// ─── Fuzzy word match: does word A ~match word B? ───
function fuzzyMatch(a, b) {
  var na = norm(a);
  var nb = norm(b);
  // Exact match
  if (na === nb) return true;
  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  // Root match: "architecte" root → "architect", "architect" root → "architect"
  var ra = root(a);
  var rb = root(b);
  if (ra.length >= 4 && rb.length >= 4) {
    if (ra.includes(rb) || rb.includes(ra)) return true;
  }
  // Prefix match (first 5+ chars): handles typos at the end
  var minLen = Math.min(na.length, nb.length);
  var prefixLen = Math.max(4, Math.floor(minLen * 0.7));
  if (na.substring(0, prefixLen) === nb.substring(0, prefixLen)) return true;
  // Levenshtein-like: allow 1-2 char difference for words > 5 chars
  if (na.length >= 5 && nb.length >= 5 && Math.abs(na.length - nb.length) <= 2) {
    var diffs = 0;
    var shorter = na.length <= nb.length ? na : nb;
    var longer = na.length > nb.length ? na : nb;
    var j = 0;
    for (var i = 0; i < longer.length && j < shorter.length; i++) {
      if (longer[i] === shorter[j]) { j++; }
      else { diffs++; }
    }
    diffs += (longer.length - i) + (shorter.length - j);
    if (diffs <= 2) return true;
  }
  return false;
}

// ─── Relevance score: how well does a headline match the poste keywords? ───
// Returns 0-100 score
function relevanceScore(headline, poste) {
  if (!poste || !headline) return 50; // unknown = neutral
  var kws = poste.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  if (kws.length === 0) return 50;

  var headlineWords = headline.split(/[\s,;|@·•–—\/()]+/).filter(function(w) { return w.length > 2; });
  var matches = 0;

  for (var i = 0; i < kws.length; i++) {
    var matched = false;
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) {
        matched = true;
        break;
      }
    }
    if (matched) matches++;
  }

  return Math.round((matches / kws.length) * 100);
}

// ─── Must-have matching — at least half must fuzzy-match ───
function matchesMustHave(headline, mustHave) {
  if (!mustHave) return true;
  var kws = mustHave.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var headlineWords = headline.split(/[\s,;|@·•–—\/()]+/).filter(function(w) { return w.length > 2; });
  var hits = 0;
  for (var i = 0; i < kws.length; i++) {
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) { hits++; break; }
    }
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
      // Only process limit + 3 candidates max (not all 15)
      var enriched = [];
      var enrichErrors = [];
      var maxToProcess = Math.min(fresh.length, limit + 3);

      console.log("[PROXY] Will enrich", maxToProcess, "of", fresh.length, "candidates (limit:", limit, ")");

      // Log all candidates with their usernames for debug
      for (var d = 0; d < fresh.length; d++) {
        console.log("[PROXY] Candidate", d, ":", fresh[d].name, "username:", fresh[d].username || "EMPTY");
      }

      if (enrich && fresh.length > 0) {
        var toProcess = fresh.slice(0, maxToProcess);

        for (var j = 0; j < toProcess.length; j++) {
          var c = toProcess[j];

          if (!c.username) {
            console.log("[PROXY] SKIP (no username):", c.name);
            enrichErrors.push(c.name + " (no username)");
            continue;
          }

          console.log("[PROXY] Enriching", j + 1, "/", toProcess.length, ":", c.name, "->", c.username);
          if (j > 0) await sleep(PROFILE_DELAY_MS);

          var detail = await getProfileDetail(c.username, sid);

          if (detail.error) {
            console.log("[PROXY] Enrich FAILED:", c.name, "->", detail.error);
            enrichErrors.push(c.name + " (" + detail.error + ")");
            // Still include with basic info
            enriched.push({
              name: c.name,
              headline: "",
              location: "",
              linkedinUrl: c.linkedinUrl,
              openToWork: null,
              relevance: 40
            });
            continue;
          }

          var finalHeadline = detail.headline || "";
          var finalLocation = detail.location || "";

          // Compute relevance score
          var score = relevanceScore(finalHeadline, keywords);

          // Bonus for location match
          if (location && finalLocation && locationMatches(finalLocation, location)) {
            score += 15;
          }

          // Bonus for mustHave
          if (mustHave && finalHeadline && matchesMustHave(finalHeadline, mustHave)) {
            score += 20;
          }

          // Bonus for Open to Work
          if (detail.openToWork) score += 10;

          console.log("[PROXY] ->", c.name, "| headline:", finalHeadline.substring(0, 60), "| loc:", finalLocation, "| score:", score, "| otw:", detail.openToWork);

          enriched.push({
            name: c.name,
            headline: finalHeadline,
            location: finalLocation,
            linkedinUrl: c.linkedinUrl,
            openToWork: detail.openToWork,
            relevance: score
          });
        }
      }

      // FALLBACK: if enrichment produced nothing, return raw search results
      if (enriched.length === 0 && fresh.length > 0) {
        console.log("[PROXY] FALLBACK: enrichment produced 0 results, returning raw candidates");
        enriched = fresh.slice(0, limit).map(function(c) {
          return {
            name: c.name,
            headline: "(profil non enrichi)",
            location: "",
            linkedinUrl: c.linkedinUrl,
            openToWork: null,
            relevance: 50
          };
        });
      }

      // Step 5: Sort by relevance (highest first) and take top N
      enriched.sort(function(a, b) { return b.relevance - a.relevance; });
      var results = enriched.slice(0, limit).map(function(p) {
        return {
          name: p.name,
          headline: p.headline,
          location: p.location,
          linkedinUrl: p.linkedinUrl,
          openToWork: p.openToWork,
          relevance: p.relevance
        };
      });

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

      console.log("[PROXY] Final:", results.length, "profiles (top by relevance)");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        profiles: results,
        count: results.length,
        totalCandidates: candidates.length,
        duplicatesSkipped: duplicatesSkipped,
        duplicatesCount: duplicatesSkipped.length,
        enrichErrors: enrichErrors || []
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

server.listen(PORT, () => console.log("LinkedIn proxy v7 on port " + PORT));        catch (e) { resolve({ result: null, sessionId: sid, rawData: data }); }
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

    // Get the person's name from first line to skip it if repeated
    var personName = lines.length > 0 ? norm(lines[0]) : "";

    // Look for headline and location
    for (var li = 1; li < Math.min(lines.length, 25); li++) {
      var line = lines[li];
      if (isSkipLine(line)) continue;

      // Skip if line is just the person's name repeated
      if (norm(line) === personName) continue;
      // Skip if line is a subset of the name or vice versa
      if (personName && norm(line).length > 3 &&
          (personName.includes(norm(line)) || norm(line).includes(personName))) continue;

      // Headline = first substantial text after name
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

// ─── Normalize text (lowercase, strip accents) ───
function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ─── Root of a word (strip common French/English suffixes) ───
function root(word) {
  var w = norm(word);
  // Remove common endings to get root: architecte→architect, developer→develop
  w = w.replace(/(eur|eure|euse|trice|iste|tion|ment|ing|tion|sion|ance|ence|able|ible|ment)$/, "");
  // If word is long enough, also try trimming last 1-2 chars for fuzzy
  if (w.length > 6) return w.substring(0, w.length); // keep full root
  return w;
}

// ─── Fuzzy word match: does word A ~match word B? ───
function fuzzyMatch(a, b) {
  var na = norm(a);
  var nb = norm(b);
  // Exact match
  if (na === nb) return true;
  // One contains the other
  if (na.includes(nb) || nb.includes(na)) return true;
  // Root match: "architecte" root → "architect", "architect" root → "architect"
  var ra = root(a);
  var rb = root(b);
  if (ra.length >= 4 && rb.length >= 4) {
    if (ra.includes(rb) || rb.includes(ra)) return true;
  }
  // Prefix match (first 5+ chars): handles typos at the end
  var minLen = Math.min(na.length, nb.length);
  var prefixLen = Math.max(4, Math.floor(minLen * 0.7));
  if (na.substring(0, prefixLen) === nb.substring(0, prefixLen)) return true;
  // Levenshtein-like: allow 1-2 char difference for words > 5 chars
  if (na.length >= 5 && nb.length >= 5 && Math.abs(na.length - nb.length) <= 2) {
    var diffs = 0;
    var shorter = na.length <= nb.length ? na : nb;
    var longer = na.length > nb.length ? na : nb;
    var j = 0;
    for (var i = 0; i < longer.length && j < shorter.length; i++) {
      if (longer[i] === shorter[j]) { j++; }
      else { diffs++; }
    }
    diffs += (longer.length - i) + (shorter.length - j);
    if (diffs <= 2) return true;
  }
  return false;
}

// ─── Relevance score: how well does a headline match the poste keywords? ───
// Returns 0-100 score
function relevanceScore(headline, poste) {
  if (!poste || !headline) return 50; // unknown = neutral
  var kws = poste.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  if (kws.length === 0) return 50;

  var headlineWords = headline.split(/[\s,;|@·•–—\/()]+/).filter(function(w) { return w.length > 2; });
  var matches = 0;

  for (var i = 0; i < kws.length; i++) {
    var matched = false;
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) {
        matched = true;
        break;
      }
    }
    if (matched) matches++;
  }

  return Math.round((matches / kws.length) * 100);
}

// ─── Must-have matching — at least half must fuzzy-match ───
function matchesMustHave(headline, mustHave) {
  if (!mustHave) return true;
  var kws = mustHave.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var headlineWords = headline.split(/[\s,;|@·•–—\/()]+/).filter(function(w) { return w.length > 2; });
  var hits = 0;
  for (var i = 0; i < kws.length; i++) {
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) { hits++; break; }
    }
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
      var enriched = [];
      var filtered = { location: [] };

      if (enrich && fresh.length > 0) {
        // Enrich up to limit*3 profiles (to have enough after filtering)
        var toProcess = fresh.slice(0, Math.min(fresh.length, limit * 3, 15));

        for (var j = 0; j < toProcess.length; j++) {
          var c = toProcess[j];
          if (!c.username) continue;

          console.log("[PROXY] Enriching", j + 1, "/", toProcess.length, ":", c.name);
          if (j > 0) await sleep(PROFILE_DELAY_MS);

          var detail = await getProfileDetail(c.username, sid);
          var finalHeadline = detail.headline || "";
          var finalLocation = detail.location || "";

          // HARD filter: location only
          if (location && finalLocation && !locationMatches(finalLocation, location)) {
            console.log("[PROXY] Skip (location):", c.name, "->", finalLocation);
            filtered.location.push(c.name);
            continue;
          }

          // Compute relevance score based on poste keywords
          var score = relevanceScore(finalHeadline, keywords);

          // Bonus for mustHave match
          if (mustHave && finalHeadline && matchesMustHave(finalHeadline, mustHave)) {
            score += 20;
          }

          // Bonus for Open to Work
          if (detail.openToWork) score += 10;

          console.log("[PROXY] ->", c.name, "| headline:", finalHeadline.substring(0, 60), "| score:", score, "| otw:", detail.openToWork);

          enriched.push({
            name: c.name,
            headline: finalHeadline,
            location: finalLocation,
            linkedinUrl: c.linkedinUrl,
            openToWork: detail.openToWork,
            relevance: score
          });

          // Stop enriching if we have enough high-relevance results
          var highRelevance = enriched.filter(function(e) { return e.relevance >= 50; });
          if (highRelevance.length >= limit + 2) break;
        }
      } else {
        // No enrichment
        enriched = fresh.slice(0, limit).map(function(c) {
          return {
            name: c.name, headline: "", location: "",
            linkedinUrl: c.linkedinUrl, openToWork: null, relevance: 50
          };
        });
      }

      // Step 5: Sort by relevance (highest first) and take top N
      enriched.sort(function(a, b) { return b.relevance - a.relevance; });
      var results = enriched.slice(0, limit).map(function(p) {
        return {
          name: p.name,
          headline: p.headline,
          location: p.location,
          linkedinUrl: p.linkedinUrl,
          openToWork: p.openToWork,
          relevance: p.relevance
        };
      });

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

      console.log("[PROXY] Final:", results.length, "profiles (top by relevance)");

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
