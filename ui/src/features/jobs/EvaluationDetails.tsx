const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const checkLabels: Record<string, string> = {
  degree: "学历",
  graduation: "毕业届别",
  graduation_year: "毕业届别",
  job_type: "岗位类型",
  certificate: "证书",
  experience: "经验",
  record: "岗位正文",
  degree_policy: "学历策略",
};
const statuses: Record<string, string> = {
  pass: "符合已知要求",
  fail: "不符合明确要求",
  unknown: "待核实",
};
const componentLabels: Record<string, string> = {
  role: "岗位方向",
  skills: "技能匹配",
  city: "城市",
  major: "专业",
  eligibility: "资格",
};
function requirementText(value: unknown): string {
  if (typeof value === "string")
    return (
      (
        { campus: "校招", internship: "实习", social: "社招" } as Record<
          string,
          string
        >
      )[value] || value
    );
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value))
    return value.map(requirementText).filter(Boolean).join("、");
  return "";
}
function evidenceTexts(value: unknown): string[] {
  return list(value).flatMap((item) => {
    if (typeof item === "string") return [item];
    const evidence = object(item);
    const excerpt =
      text(evidence.excerpt) ||
      text(evidence.matchedText) ||
      text(evidence.reason);
    return excerpt ? [excerpt] : [];
  });
}
function Evidence({ value }: { value: unknown }) {
  return (
    <>
      {evidenceTexts(value).map((excerpt, i) => (
        <p
          key={i}
          className="whitespace-pre-wrap text-sm text-muted-foreground"
        >
          {excerpt}
        </p>
      ))}
    </>
  );
}
export function EvaluationDetails({
  evaluation,
}: {
  evaluation: Record<string, unknown>;
}) {
  const qualification = object(evaluation.qualification),
    checks = list(qualification.checks);
  const components = Object.entries(object(evaluation.components));
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {(
          {
            rules: "规则评价",
            ai: "模型辅助评价",
            rule_fallback: "模型回退后的规则评价",
            rules_fallback: "模型回退后的规则评价",
          } as Record<string, string>
        )[text(evaluation.status)] || "评价方式待确认"}
      </p>
      {list(evaluation.reasons).map(
        (reason, i) => text(reason) && <p key={i}>{text(reason)}</p>,
      )}
      {!!checks.length && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">资格核对</h3>
          {checks.map((value, i) => {
            const check = object(value),
              evidence = object(check.evidence);
            return (
              <div key={i} className="rounded-md border p-3">
                <p>
                  {checkLabels[text(check.type)] || "资格要求"} ·{" "}
                  {statuses[text(check.status)] || "待核实"}
                </p>
                {requirementText(check.requirement) && (
                  <p>要求：{requirementText(check.requirement)}</p>
                )}
                {text(check.reason) && <p>{text(check.reason)}</p>}
                {text(evidence.excerpt) && (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {text(evidence.excerpt)}
                  </p>
                )}
              </div>
            );
          })}
        </section>
      )}
      {!!components.length && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">评分组成</h3>
          {components.map(([name, value]) => {
            const component = object(value);
            return (
              <div key={name} className="rounded-md border p-3">
                <p className="font-medium">
                  {componentLabels[name] || "其他匹配项"}
                </p>
                <p>
                  {typeof component.score === "number" ? component.score : "—"}{" "}
                  / {typeof component.max === "number" ? component.max : "—"} 分
                </p>
                <Evidence value={component.evidence} />
              </div>
            );
          })}
        </section>
      )}
      {!!evidenceTexts(evaluation.evidence).length && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">匹配证据</h3>
          <Evidence value={evaluation.evidence} />
        </section>
      )}
      {!!list(evaluation.gaps).length && (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">待核实与缺口</h3>
          {list(evaluation.gaps).map(
            (gap, i) => text(gap) && <p key={i}>{text(gap)}</p>,
          )}
        </section>
      )}
    </div>
  );
}
