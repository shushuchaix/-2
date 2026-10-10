const identityFields = new Set([
  "name",
  "fullname",
  "realname",
  "school",
  "university",
  "college",
  "phone",
  "mobile",
  "tel",
  "telephone",
  "email",
  "address",
  "homeaddress",
  "contact",
  "contacts",
  "wechat",
  "weixin",
  "qq",
  "idnumber",
  "idcard",
  "studentid",
  "employeeid",
  "company",
  "employer",
  "姓名",
  "学校",
  "院校",
  "手机",
  "电话",
  "邮箱",
  "地址",
  "微信",
  "身份证",
  "学号",
]);
const comparable = (value) =>
  value
    .normalize("NFKC")
    .replace(/[\s\u200b-\u200d\ufeff]/g, "")
    .toLowerCase();
const contactPattern =
  /[\p{L}\p{N}._%+\-]+@[\p{L}\p{N}.\-]+\.[\p{L}]{2,}|(?:\+?86[-.\s]*)?1[3-9](?:[-.\s]*\d){9}|(?<![A-Za-z0-9])\d{17}[\dXx](?![A-Za-z0-9])|(?:姓名|学校|毕业院校|院校|单位|公司|邮箱|电子邮件|email|手机|电话|phone|wechat|weixin|微信|qq|身份证|学号|住址|地址|联系人)\s*[:：=]/iu;

/** Keep only job-fit facts. Identity-bearing entries are withheld, not rewritten. */
export function anonymizeModelProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile))
    return {};
  const identities = new Set();
  const collect = (value, depth = 0) => {
    if (typeof value === "string" && value.trim())
      identities.add(comparable(value));
    else if (value && typeof value === "object" && depth < 4)
      for (const child of Object.values(value)) collect(child, depth + 1);
  };
  for (const [field, value] of Object.entries(profile))
    if (identityFields.has(field.toLowerCase())) collect(value);
  for (const field of [
    "internships",
    "employment",
    "workExperience",
    "educationHistory",
  ])
    for (const item of Array.isArray(profile[field]) ? profile[field] : [])
      if (item && typeof item === "object")
        for (const [key, value] of Object.entries(item))
          if (
            identityFields.has(key.toLowerCase()) ||
            /^(?:institution|organization)$/i.test(key)
          )
            collect(value);
  const clean = (value) => {
    if (typeof value !== "string") return undefined;
    const text = value.trim();
    if (!text || text.length > 200) return undefined;
    const normalized = text
      .normalize("NFKC")
      .replace(/[\u200b-\u200d\ufeff]/g, "");
    if (contactPattern.test(normalized)) return undefined;
    const key = comparable(text);
    for (const identity of identities)
      if (key.includes(identity)) return undefined;
    return text;
  };
  const result = {};
  for (const field of ["degree", "education", "major"])
    if (clean(profile[field]) !== undefined)
      result[field] = clean(profile[field]);
  const year = profile.graduationYear;
  if (
    /^\d{4}$/.test(String(year)) &&
    Number(year) >= 1900 &&
    Number(year) <= 2100
  )
    result.graduationYear = year;
  if (
    typeof profile.experienceYears === "number" &&
    Number.isFinite(profile.experienceYears) &&
    profile.experienceYears >= 0 &&
    profile.experienceYears <= 80
  )
    result.experienceYears = profile.experienceYears;
  for (const field of ["targetRoles", "jobTypes", "skills", "certificates"]) {
    if (!Array.isArray(profile[field])) continue;
    const values = [];
    for (const item of profile[field].slice(0, 100)) {
      if (typeof item === "string") {
        const value = clean(item);
        if (value !== undefined) values.push(value);
      } else if (
        ["skills", "certificates"].includes(field) &&
        item &&
        typeof item === "object"
      ) {
        const name = clean(item.name);
        if (name === undefined) continue;
        const value = { name };
        if (field === "skills")
          for (const key of ["level", "proficiency"])
            if (clean(item[key]) !== undefined) value[key] = clean(item[key]);
        values.push(value);
      }
    }
    if (values.length) result[field] = values;
  }
  return result;
}
