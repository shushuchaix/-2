import fs from "node:fs";
const ontology = JSON.parse(
  fs.readFileSync(new URL("./ontology.json", import.meta.url), "utf8"),
);
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ASCII boundaries permit Chinese neighbours, but keep C, C++ and C# distinct.
export function termEvidence(text, term) {
  const source = String(text || "").normalize("NFKC");
  const needle = String(term || "")
    .normalize("NFKC")
    .trim();
  if (!needle) return [];
  const asciiStart = /^[A-Za-z0-9]/.test(needle);
  const asciiEnd = /[A-Za-z0-9+#.]$/.test(needle);
  const pattern = `${asciiStart ? "(?<![A-Za-z0-9_])" : ""}${escape(needle).replace(/\s+/g, "\\s*")}${asciiEnd ? "(?![A-Za-z0-9_+#])" : ""}`;
  return [...source.matchAll(new RegExp(pattern, "gi"))].map((m) => ({
    matchedText: m[0],
    start: m.index,
    end: m.index + m[0].length,
  }));
}
export function findSkillEvidence(text, skillIds) {
  const results = [];
  for (const id of skillIds) {
    const entry = ontology.skills.find(
      (s) =>
        s.id === id ||
        s.name.toLowerCase() === String(id).toLowerCase() ||
        s.aliases.some((a) => a.toLowerCase() === String(id).toLowerCase()),
    );
    const terms = entry
      ? [
          [entry.name, "exact"],
          ...entry.aliases.map((a) => [a, "alias"]),
          ...entry.related.map((a) => [a, "related"]),
        ]
      : [[String(id), "exact"]];
    for (const [term, relation] of terms)
      for (const evidence of termEvidence(text, term))
        results.push({ skillId: entry?.id || id, ...evidence, relation });
  }
  return results.filter(
    (x, i, a) =>
      a.findIndex(
        (y) =>
          y.skillId === x.skillId && y.start === x.start && y.end === x.end,
      ) === i,
  );
}
export function majorRoleFit(profile, record) {
  const major = String(profile?.major || "");
  const text = [
    record.title,
    record.extra?.major,
    record.description,
    ...(record.tags || []),
  ]
    .filter(Boolean)
    .join(" ");
  if (!major || !text) return { status: "unknown", reasons: [] };
  if (/不限专业|专业不限/.test(text))
    return { status: "unknown", reasons: ["专业不限"] };
  if (text.includes(major.replace(/专业$/, "")))
    return { status: "matched", reasons: [`专业 ${major} 有明确证据`] };
  const own = ontology.families.filter((f) =>
    f.majors.some((m) => termEvidence(major, m).length),
  );
  const required = ontology.families.filter((f) =>
    f.roles.some((m) => termEvidence(text, m).length),
  );
  const common = own.find((f) => required.some((r) => r.id === f.id));
  if (common)
    return { status: "matched", reasons: [`岗位与专业同属 ${common.id}`] };
  return {
    status: own.length && required.length ? "mismatch" : "unknown",
    reasons: own.length && required.length ? ["岗位方向与专业族不同"] : [],
  };
}
