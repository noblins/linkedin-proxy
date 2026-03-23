const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const MCP_URL = process.env.MCP_URL || "https://linkedin-scraper-zvms.onrender.com/mcp";
const PORT = process.env.PORT || 3000;
const SEEN_FILE = path.join(__dirname, "seen-profiles.json");
const PROFILE_DELAY_MS = 4000;

function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); } catch (e) { return {}; }
}
function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}

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
        try {
          resolve({ result: JSON.parse(data), sessionId: sid });
        } catch (e) {
          resolve({ result: null, sessionId: sid, rawData: data });
        }
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
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "proxy", version: "7.0" }
    }
  });
  return r.sessionId;
}

function sleep(ms) {
  return new Promise(function(r) { setTimeout(r, ms); });
}

function norm(s) {
  return s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function root(word) {
  var w = norm(word);
  w = w.replace(/(eur|eure|euse|trice|iste|tion|ment|ing|sion|ance|ence|able|ible)$/, "");
  return w;
}

function fuzzyMatch(a, b) {
  var na = norm(a);
  var nb = norm(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  var ra = root(a);
  var rb = root(b);
  if (ra.length >= 4 && rb.length >= 4) {
    if (ra.includes(rb) || rb.includes(ra)) return true;
  }
  var minLen = Math.min(na.length, nb.length);
  var prefixLen = Math.max(4, Math.floor(minLen * 0.7));
  if (na.substring(0, prefixLen) === nb.substring(0, prefixLen)) return true;
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

function relevanceScore(headline, poste) {
  if (!poste || !headline) return 50;
  var kws = poste.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  if (kws.length === 0) return 50;
  var headlineWords = headline.split(/[\s,;|@\/()]+/).filter(function(w) { return w.length > 2; });
  var matches = 0;
  for (var i = 0; i < kws.length; i++) {
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) { matches++; break; }
    }
  }
  return Math.round((matches / kws.length) * 100);
}

function matchesMustHave(headline, mustHave) {
  if (!mustHave) return true;
  var kws = mustHave.split(/[\s,;]+/).filter(function(k) { return k.length > 2; });
  var headlineWords = headline.split(/[\s,;|@\/()]+/).filter(function(w) { return w.length > 2; });
  var hits = 0;
  for (var i = 0; i < kws.length; i++) {
    for (var j = 0; j < headlineWords.length; j++) {
      if (fuzzyMatch(kws[i], headlineWords[j])) { hits++; break; }
    }
  }
  return hits >= Math.ceil(kws.length / 2);
}

function locationMatches(profileLoc, requestedLoc) {
  if (!requestedLoc || !profileLoc) return true;
  var reqN = norm(requestedLoc);
  var profN = norm(profileLoc);
  var aliases = {
    "paris": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "ile-de-france": ["paris", "ile-de-france", "ile de france", "idf", "region parisienne", "greater paris"],
    "lyon": ["lyon", "rhone", "auvergne-rhone-alpes"],
    "marseille": ["marseille", "bouches-du-rhone", "provence", "paca"],
    "toulouse": ["toulouse", "haute-garonne", "occitanie"],
    "bordeaux": ["bordeaux", "gironde", "nouvelle-aquitaine"],
    "lille": ["lille", "nord", "hauts-de-france"],
    "nantes": ["nantes", "loire-atlantique", "pays de la loire"],
    "france": ["france"]
  };
  var reqAliases = aliases[reqN] || [reqN];
  for (var i = 0; i < reqAliases.length; i++) {
    if (profN.includes(reqAliases[i])) return true;
  }
  return profN.includes(reqN) || reqN.includes(profN);
}

function extractPersonRefs(mcpResult) {
  if (!mcpResult || !mcpResult.result) return [];
  var r = mcpResult.result;
  var refs = null;
  if (r.structuredContent && r.structuredContent.references) {
    var allRefs = r.structuredContent.references;
    if (allRefs.search_results) refs = allRefs.search_results;
    else if (Array.isArray(allRefs)) refs = allRefs;
  }
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
  var persons = [];
  var seenUrls = {};
  for (var j = 0; j < refs.length; j++) {
    var ref = refs[j];
    if (ref.kind === "person" && ref.url && ref.text) {
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

function isSkipLine(line) {
  if (line.length <= 3) return true;
  if (/^(Se connecter|Connect|Follow|Suivre|Message|Envoyer un message|Plus|Accueil|Home|Mon réseau|Emplois|Jobs|Notifications|Messagerie|Recherche|Premium)$/i.test(line)) return true;
  if (/relation\s+de\s+\d+/i.test(line)) return true;
  if (/^\d+(st|nd|rd|th)\s+(degree\s+)?connection/i.test(line)) return true;
  if (/^relation\s+de/i.test(line)) return true;
  if (/^\d+\s+(relation|connection|follower|abonne|contact)/i.test(line)) return true;
  if (/^\+?\d+\s+(relation|connection)/i.test(line)) return true;
  if (/^plus de \d+/i.test(line)) return true;
  if (/^(Coordonnees|Contact info|Voir le profil|Open to work|Disponible)/i.test(line)) return true;
  if (/^(Afficher|Voir|Show|Modifier|Edit|Ajouter)\s/i.test(line)) return true;
  if (/^(En savoir plus|See more|Voir plus)/i.test(line)) return true;
  if (/^(Experience|Formation|Education|Competences|Skills|Licences|Certifications|Langues|Languages|Recommandations|Recommendations|Activite|Activity)$/i.test(line)) return true;
  return false;
}

async function getProfileDetail(username, sessionId) {
  try {
    var resp = await mcpRequest({
      jsonrpc: "2.0",
      id: "p-" + username,
      method: "tools/call",
      params: {
        name: "get_person_profile",
        arguments: { linkedin_username: username }
      }
    }, sessionId);

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
              if (parsed.sections) {
                text = Object.values(parsed.sections).join("\n\n");
              } else {
                text = r.content[i].text;
              }
            } catch (e) {
              text = r.content[i].text;
            }
          }
        }
      }
    }

    var lower = text.toLowerCase();
    var openToWork = lower.includes("open to work") ||
      lower.includes("disponible pour") ||
      lower.includes("ouvert aux opportunit") ||
      lower.includes("#opentowork") ||
      lower.includes("actively seeking");

    var lines = text.split("\n").map(function(l) { return l.trim(); }).filter(function(l) { return l.length > 0; });
    var headline = "";
    var location = "";
    var personName = lines.length > 0 ? norm(lines[0]) : "";

    for (var li = 1; li < Math.min(lines.length, 25); li++) {
      var line = lines[li];
      if (isSkipLine(line)) continue;
      var lineNorm = norm(line);
      if (lineNorm === personName) continue;
      if (personName && lineNorm.length > 3) {
        if (personName.includes(lineNorm) || lineNorm.includes(personName)) continue;
      }
      if (!headline && line.length > 5) {
        headline = line;
        continue;
      }
      if (headline && !location && line.length > 2 && line.length < 100) {
        if (!/^\d/.test(line) && !/^(Current|Past|Actuel|Formation|Education)/i.test(line)) {
          location = line;
          break;
        }
      }
    }

    console.log("[PROXY] Profile:", username, "headline:", headline.substring(0, 80), "| loc:", location, "| otw:", openToWork);
    return { openToWork: openToWork, headline: headline, location: location };
  } catch (err) {
    console.error("[PROXY] Profile error:", username, err.message);
    return { openToWork: false, headline: "", location: "", error: err.message };
  }
}

var server = http.createServer(async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: "7.1" }));
    return;
  }

  if (req.method === "GET" && req.url === "/tools") {
    try {
      var sid = await initMcp();
      var tools = await mcpRequest({ jsonrpc: "2.0", id: "t1", method: "tools/list", params: {} }, sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(tools.result, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/profile") {
    var body = "";
    for await (var chunk of req) body += chunk;
    try {
      var params = JSON.parse(body);
      var sid = await initMcp();
      var detail = await getProfileDetail(params.username || "", sid);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(detail, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/search") {
    var body = "";
    for await (var chunk of req) body += chunk;

    try {
      var params = JSON.parse(body);
      var keywords = params.keywords || "";
      var location = params.location || "";
      var mustHave = params.mustHave || "";
      var limit = parseInt(params.limit) || 5;
      var deduplicate = params.deduplicate !== false;

      console.log("[PROXY] Search:", JSON.stringify({ keywords: keywords, location: location, mustHave: mustHave, limit: limit }));

      var sid = await initMcp();

      var search = await mcpRequest({
        jsonrpc: "2.0", id: "s1", method: "tools/call",
        params: { name: "search_people", arguments: { keywords: keywords, location: location } }
      }, sid);

      var candidates = extractPersonRefs(search.result);
      console.log("[PROXY] Found", candidates.length, "person refs");

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

      var enriched = [];
      var enrichErrors = [];
      var maxToProcess = Math.min(fresh.length, limit + 3);

      console.log("[PROXY] Will enrich", maxToProcess, "of", fresh.length, "(limit:", limit, ")");

      for (var d = 0; d < fresh.length; d++) {
        console.log("[PROXY] Candidate", d, ":", fresh[d].name, "user:", fresh[d].username || "EMPTY");
      }

      if (fresh.length > 0) {
        var toProcess = fresh.slice(0, maxToProcess);
        for (var j = 0; j < toProcess.length; j++) {
          var c = toProcess[j];
          if (!c.username) {
            console.log("[PROXY] SKIP no username:", c.name);
            enrichErrors.push(c.name + " (no username)");
            continue;
          }
          console.log("[PROXY] Enriching", (j + 1), "/", toProcess.length, ":", c.name, "->", c.username);
          if (j > 0) await sleep(PROFILE_DELAY_MS);

          var detail = await getProfileDetail(c.username, sid);

          if (detail.error) {
            console.log("[PROXY] FAIL:", c.name, detail.error);
            enrichErrors.push(c.name + " (" + detail.error + ")");
            enriched.push({
              name: c.name, headline: "", location: "",
              linkedinUrl: c.linkedinUrl, openToWork: null, relevance: 40
            });
            continue;
          }

          var h = detail.headline || "";
          var loc = detail.location || "";
          var score = relevanceScore(h, keywords);
          if (location && loc && locationMatches(loc, location)) score += 15;
          if (mustHave && h && matchesMustHave(h, mustHave)) score += 20;
          if (detail.openToWork) score += 10;

          console.log("[PROXY] ->", c.name, "h:", h.substring(0, 60), "loc:", loc, "score:", score, "otw:", detail.openToWork);

          enriched.push({
            name: c.name, headline: h, location: loc,
            linkedinUrl: c.linkedinUrl, openToWork: detail.openToWork, relevance: score
          });
        }
      }

      if (enriched.length === 0 && fresh.length > 0) {
        console.log("[PROXY] FALLBACK: returning raw candidates");
        enriched = fresh.slice(0, limit).map(function(c) {
          return {
            name: c.name, headline: "(non enrichi)", location: "",
            linkedinUrl: c.linkedinUrl, openToWork: null, relevance: 50
          };
        });
      }

      enriched.sort(function(a, b) { return b.relevance - a.relevance; });
      var results = enriched.slice(0, limit);

      if (deduplicate) {
        for (var s = 0; s < results.length; s++) {
          seen[results[s].linkedinUrl] = {
            name: results[s].name, search: keywords,
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
        enrichErrors: enrichErrors
      }));
    } catch (err) {
      console.error("[PROXY] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "GET" && req.url === "/seen") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(loadSeen(), null, 2));
    return;
  }

  if (req.method === "DELETE" && req.url === "/seen") {
    saveSeen({});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "cleared" }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, function() {
  console.log("LinkedIn proxy v7.1 on port " + PORT);
});
