import { useState } from "react";
import type {
  ApiClient,
  CollectionActivity,
  DesktopAdapter,
  Scope,
} from "../../lib/types";
import { useOperation } from "../../lib/hooks";
import { TextField } from "../../components/TextField";
import { OperationFeedback } from "../../components/OperationFeedback";
import { Button } from "../../components/ui/button";
import { Field, FieldLabel, FieldDescription } from "../../components/ui/field";
import { Switch } from "../../components/ui/switch";
import { CollectionSessionDialog } from "./CollectionSessionDialog";
import type { SourceSummary } from "./SiteDialog";
import type { SourceDraft } from "./source-view";

export function SourceSettings({
  api,
  desktop,
  source,
  scope,
  activity,
  generation,
  draft,
  onDraftChange,
  onChanged,
}: {
  api: ApiClient;
  desktop: DesktopAdapter;
  source: SourceSummary;
  scope: Scope | null;
  activity: CollectionActivity | null;
  generation: number;
  draft: SourceDraft;
  onDraftChange(draft: SourceDraft): void;
  onChanged(): void;
}) {
  const op = useOperation();
  const [dirty, setDirty] = useState(false);
  const [proof, setProof] = useState(source.serviceCapability);
  const [paid, setPaid] = useState(false);
  const [login, setLogin] = useState(false);
  const social = source.sourceId === "wechat" || source.sourceId === "weibo";
  const active =
    activity?.collectionProgress.status === "collecting" ? activity : null;
  function change(next: SourceDraft) {
    onDraftChange(next);
    setDirty(true);
    op.clear();
  }
  async function save(next = draft) {
    if (op.busy || !scope) return;
    onDraftChange(next);
    setDirty(true);
    const ok = await op.run(async () => {
      await api.request(
        "/sources/" + encodeURIComponent(source.sourceId) + "/settings",
        {
          method: "PUT",
          scope,
          body: {
            config: {
              ...source.config,
              enabled: next.enabled,
              ...(social
                ? {
                    articleUrls: next.urls
                      .split(/\n/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                    accountIds: next.accounts
                      .split(/\n/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  }
                : {}),
            },
          },
        },
      );
      onChanged();
    }, "来源设置已保存");
    if (ok) setDirty(false);
  }
  return (
    <section aria-label="本版本来源配置" className="flex flex-col gap-4">
      <h2>本版本来源配置</h2>
      {!scope && (
        <p>全部目标视图仅可阅读共享目录；选择一个版本后修改启用配置和登录。</p>
      )}
      <Field orientation="horizontal">
        <Switch
          id={"enabled-" + source.sourceId}
          aria-label={"启用" + source.name}
          checked={draft.enabled}
          disabled={
            op.busy ||
            !scope ||
            (source.optionalService &&
              !draft.enabled &&
              proof?.enabled !== true)
          }
          onCheckedChange={(v) => void save({ ...draft, enabled: v })}
        />
        <div>
          <FieldLabel htmlFor={"enabled-" + source.sourceId}>
            {"启用" + source.name}
          </FieldLabel>
          <FieldDescription>
            启用修改后自动保存，失败时保留选择并可重试。
          </FieldDescription>
        </div>
      </Field>
      {social && (
        <>
          <TextField
            name={"social-urls-" + source.sourceId}
            label="已知公开文章/帖子链接（每行一个）"
            multiline
            value={draft.urls}
            disabled={!scope || op.busy}
            onChange={(urls) => change({ ...draft, urls })}
          />
          <TextField
            name={"social-accounts-" + source.sourceId}
            label="官方机构公开账号标识（每行一个）"
            multiline
            value={draft.accounts}
            disabled={!scope || op.busy}
            onChange={(accounts) => change({ ...draft, accounts })}
            description={
              source.sourceId === "wechat"
                ? "公开文章中的 __biz 标识；历史可见范围以实际返回为准"
                : "微博数字 UID；以实际游标分批采集"
            }
          />
          <p className="text-sm text-muted-foreground">
            读取公开正文、长文、海报与附件的范围以返回内容为准；验证码或登录限制会暂停该来源并保留进度。
          </p>
        </>
      )}
      {(social || source.sourceId === "boss") && (
        <>
          <Button
            variant="outline"
            disabled={!scope}
            onClick={() => setLogin(true)}
          >
            {source.name}独立登录
          </Button>
          {source.sourceId === "boss" && (
            <p className="text-sm text-muted-foreground">
              本版本独立登录后按原活动累计额度核验列表与正文；风险阻塞需明确重新核验后解除。
            </p>
          )}
        </>
      )}
      {source.optionalService && (
        <section
          aria-label="可选官方服务"
          className="flex flex-col gap-3 rounded-lg border p-4"
        >
          <h3>可选官方服务</h3>
          <p>
            账号能力：{String(proof?.state ?? "未检查")} · 正文：
            {proof?.bodyCapability ? "已验证" : "未验证"} · 价格：
            {String(proof?.pricingState ?? "未知")} · 检查时间：
            {String(proof?.checkedAt ?? "暂无")}
          </p>
          <Button
            variant="outline"
            disabled={op.busy || !scope || !active}
            onClick={() => {
              if (!scope || !active) return;
              void op.run(async () => {
                const result = await api.request<Record<string, unknown>>(
                  "/sources/" + source.sourceId + "/probe",
                  { method: "POST", scope, body: { activityId: active.runId } },
                );
                setProof(result);
              }, "官方读取能力检查已完成");
            }}
          >
            检查本版本官方读取能力
          </Button>
          <label className="flex gap-2">
            <input
              type="checkbox"
              disabled={op.busy || proof?.pricingState !== "paid" || !scope}
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
            />
            已核对官方服务的独立费用
          </label>
          <Button
            variant="outline"
            disabled={
              op.busy ||
              !scope ||
              proof?.bodyCapability !== true ||
              !proof?.proofId ||
              (proof?.pricingState === "paid" && !paid)
            }
            onClick={() => {
              if (!scope || op.busy) return;
              void op.run(async () => {
                const result = await api.request<Record<string, unknown>>(
                  "/sources/" + source.sourceId + "/service",
                  {
                    method: "POST",
                    scope,
                    body: {
                      proofId: proof?.proofId,
                      paidServiceAcknowledged: paid,
                    },
                  },
                );
                setProof(result);
                onDraftChange({ ...draft, enabled: true });
                onChanged();
              }, "已开通本版本官方读取通道");
            }}
          >
            按已核验能力开通
          </Button>
          <p className="text-sm text-muted-foreground">
            可选官方服务默认关闭。必须先核实账号读取权限、正文能力、额度与价格；未开通时仍使用公开网页。
          </p>
        </section>
      )}
      <OperationFeedback
        busy={op.busy}
        result={op.message}
        error={op.error}
        busyLabel="正在更新本版本来源设置…"
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={op.busy || !scope}
          onClick={() => void save()}
        >
          {op.busy ? "正在保存来源设置…" : "保存来源设置"}
        </Button>
        {dirty && (
          <Button
            variant="outline"
            disabled={op.busy || !scope}
            onClick={() => void save()}
          >
            重试保存来源设置
          </Button>
        )}
      </div>
      {login && scope && (
        <CollectionSessionDialog
          key={JSON.stringify([scope, generation, source.sourceId])}
          api={api}
          desktop={desktop}
          scope={scope}
          activity={activity}
          platform={source.sourceId as "wechat" | "weibo" | "boss"}
          initialSessionRef={source.sessionRef || undefined}
          onChanged={onChanged}
          onClose={() => setLogin(false)}
        />
      )}
    </section>
  );
}
