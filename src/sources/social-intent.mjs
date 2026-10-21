/** Conservative classification. Evidence always points to literal source text. */
export function classifyRecruitmentIntent({ text = "" } = {}) {
  const rules = [
    [
      "candidate_seeking",
      /本人[\s\S]{0,80}(?:求职|找工作)|求职意向|求职简历|寻找工作/,
    ],
    ["training", /培训班招生|考证辅导|课程招生|培训机构招生/],
    [
      "employer_recruitment",
      /(?:现招聘|招聘条件|招聘岗位|招聘公告|诚聘|招募员工|校园招聘|社会招聘|招聘[:：]|(?:公司|集团|单位)[\s\S]{0,30}招聘)/,
    ],
    ["news", /行业新闻|记者采访|行业资讯|新闻报道/],
  ];
  for (const [intent, pattern] of rules) {
    const match = pattern.exec(text);
    if (match)
      return {
        intent,
        evidence: [
          {
            start: match.index,
            end: match.index + match[0].length,
            quote: match[0],
          },
        ],
      };
  }
  return { intent: "unknown", evidence: [] };
}
