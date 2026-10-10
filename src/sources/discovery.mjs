import { parseHTML } from "linkedom";
import { createHash } from "node:crypto";
import { validatePublicUrl } from "../infrastructure/http/public-url.mjs";
const recruiting = /招聘|人才|就业|careers?|recruit|\bjobs?\b/i;
const knownHost = (host) =>
  /(?:^|\.)(?:91job\.org\.cn|smartrecruiters\.com|greenhouse\.io|hotjob\.cn)$/.test(
    host,
  );
function safe(value) {
  const url = validatePublicUrl(value);
  url.hash = "";
  if (
    [...url.searchParams.keys()].some((k) =>
      /token|api.?key|auth|ticket|cookie|secret|signature|^sig$|session|password|x-amz|x-goog|expires/i.test(
        k,
      ),
    )
  )
    throw Error("Private query parameters");
  if (
    /(?:^|\/)(?:private|resume|personal|my|account|login)(?:\/|\.|$)/i.test(
      decodeURIComponent(url.pathname),
    )
  )
    throw Error("Private discovery path");
  return url;
}
const seedChannels = new Set([
  "official_platform",
  "official_employer_announcements",
  "official_airport_announcements",
  "official_group_announcements",
  "official_employer_careers",
  "official_institution",
  "wechat",
  "weibo",
  "rss",
]);
export function validatePublicSeeds(seeds) {
  if (!Array.isArray(seeds) || !seeds.length || seeds.length > 100)
    throw Error("Invalid public seeds");
  return seeds.map((seed) => {
    if (
      !seed ||
      typeof seed !== "object" ||
      Array.isArray(seed) ||
      Object.keys(seed).length !== 4 ||
      Object.keys(seed).some(
        (key) =>
          !["institutionName", "homepage", "evidenceUrl", "channel"].includes(
            key,
          ),
      ) ||
      typeof seed.institutionName !== "string" ||
      !seed.institutionName.trim() ||
      seed.institutionName.length > 200 ||
      !seedChannels.has(seed.channel)
    )
      throw Error("Invalid public seed fields");
    return {
      institutionName: seed.institutionName.trim(),
      homepage: safe(seed.homepage).href,
      evidenceUrl: safe(seed.evidenceUrl).href,
      channel: seed.channel,
    };
  });
}
export async function discoverSourceCandidates({
  seed,
  request,
  signal,
  maxDepth = 2,
  maxUrls = 100,
  archiveLookup,
}) {
  if (
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 0 ||
    maxDepth > 2 ||
    !Number.isSafeInteger(maxUrls) ||
    maxUrls < 1 ||
    maxUrls > 100
  )
    throw Error("Invalid discovery bounds");
  const entry = safe(typeof seed === "string" ? seed : seed.url),
    queue = [{ url: entry.href, depth: 0, from: entry.href }],
    seen = new Set(),
    candidates = new Map();
  if (archiveLookup) {
    const archived = await archiveLookup({
      hostname: entry.hostname,
      signal,
      limit: Math.min(20, maxUrls),
    });
    for (const value of archived || []) {
      try {
        const u = safe(value);
        if (u.origin === entry.origin)
          queue.push({
            url: u.href,
            depth: 1,
            from: entry.href,
            archived: true,
          });
      } catch {}
    }
  }
  while (queue.length && seen.size < maxUrls) {
    signal?.throwIfAborted();
    const current = queue.shift();
    if (seen.has(current.url) || current.depth > maxDepth) continue;
    seen.add(current.url);
    let response;
    try {
      response = await request(current.url, {
        signal,
        kind: "list",
        maxRetries: 0,
      });
    } catch {
      continue;
    }
    if (response.status !== 200) continue;
    const base = safe(response.url || current.url);
    if (base.origin !== entry.origin && !knownHost(base.hostname)) continue;
    const { document } = parseHTML(response.text || "");
    const links = [
      ...document.querySelectorAll(
        'a[href],link[rel="alternate"][href],sitemap loc,url loc',
      ),
    ].map((node) => ({
      href: node.getAttribute("href") || node.textContent,
      label: node.textContent || node.getAttribute("title") || "",
    }));
    for (const link of links) {
      let url;
      try {
        url = safe(new URL(link.href, base).href);
      } catch {
        continue;
      }
      if (url.origin !== entry.origin && !knownHost(url.hostname)) continue;
      if (/\.(?:pdf|docx?|xlsx?|jpg|png|gif|css|js|zip)$/i.test(url.pathname))
        continue;
      const relevant =
        recruiting.test(link.label + " " + url.pathname) ||
        knownHost(url.hostname) ||
        /sitemap|rss/i.test(url.pathname);
      if (!relevant) continue;
      const depth = current.depth + 1;
      if (depth > maxDepth) continue;
      if (
        recruiting.test(link.label + " " + url.pathname) ||
        knownHost(url.hostname)
      ) {
        let providerId = "official-announcements",
          tenantId = null;
        if (/91job\.org\.cn$/.test(url.hostname)) {
          providerId = "university-91job";
          tenantId =
            url.pathname.match(/\/sub-station\/home\/(\d{5})(?:\/|$)/)?.[1] ||
            null;
        } else if (/smartrecruiters\.com$/.test(url.hostname))
          providerId = "smartrecruiters";
        else if (/greenhouse\.io$/.test(url.hostname))
          providerId = "greenhouse";
        const id = url.origin + url.pathname;
        if (!candidates.has(id) && candidates.size < maxUrls)
          candidates.set(id, {
            siteId:
              "discovered-" +
              createHash("sha256").update(id).digest("hex").slice(0, 20),
            name: String(link.label || seed.name || url.hostname)
              .trim()
              .slice(0, 200),
            origin: url.origin,
            entryUrl: url.href,
            providerId,
            tenantId,
            category:
              providerId === "university-91job" ? "university" : "employer",
            institutionUrl: entry.href,
            evidenceUrl: current.url,
            allowedDomains: [url.hostname],
            status: "candidate",
            verifiedAt: null,
            depth,
            discoveredFromArchive: Boolean(current.archived),
            capabilities: { body: "unverified" },
          });
      }
      if (!seen.has(url.href) && queue.length < maxUrls * 2)
        queue.push({ url: url.href, depth, from: current.url });
    }
  }
  return [...candidates.values()];
}
