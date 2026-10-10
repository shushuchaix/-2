import { useEffect, useState } from "react";
import type { ApiClient, DesktopAdapter, Scope } from "../../lib/types";
import type { CollectionActivity } from "../workbench/CollectionProgress";
import { useOperation, useQuery } from "../../lib/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { TextField } from "../../components/TextField";
import { OperationFeedback } from "../../components/OperationFeedback";
export function CollectionSessionDialog({
  api,
  desktop,
  scope,
  platform,
  initialSessionRef,
  onClose,
}: {
  api: ApiClient;
  desktop: DesktopAdapter;
  scope: Scope;
  platform: "wechat" | "weibo" | "boss";
  initialSessionRef?: string;
  onClose(): void;
}) {
  const [caps, setCaps] = useState({ available: false, canRemember: false }),
    [url, setUrl] = useState(""),
    [remember, setRemember] = useState(false),
    [sessionRef, setRef] = useState(initialSessionRef || ""),
    [state, setState] = useState(""),
    [riskBlocked, setRisk] = useState(false),
    [bodyVerified, setBodyVerified] = useState(false);
  const boss = platform === "boss";
  const op = useOperation();
  const roots = useQuery<{ collections?: CollectionActivity[] }>(
      api,
      "/collections",
      scope,
    ),
    active = roots.data?.collections?.find((a) =>
      boss
        ? !["completed", "cancelled"].includes(a.collectionProgress.status)
        : a.collectionProgress.status === "collecting",
    );
  useEffect(() => {
    let live = true;
    void desktop
      .getCollectionCapabilities?.()
      .then((c) => {
        if (live) setCaps(c);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [desktop]);
  useEffect(() => {
    let live = true;
    if (boss && sessionRef && desktop.getCollectionSessionStatus)
      void desktop
        .getCollectionSessionStatus({ scope, sessionRef })
        .then((s) => {
          if (live) {
            setState(s.state);
            setRisk(s.riskBlocked);
          }
        })
        .catch(() => {
          if (live) setState("unverified");
        });
    return () => {
      live = false;
    };
  }, [boss, desktop, scope.packageId, scope.targetRevisionId, sessionRef]);
  const probeBoss = (clearRisk: boolean) =>
    op.run(async () => {
      const result = await desktop.probeBossSession!({
        scope,
        activityId: active!.runId,
        sessionRef,
        requestId: crypto.randomUUID(),
        clearRisk,
      });
      setState(result.state);
      setRisk(result.riskBlocked);
      setBodyVerified(result.sourceStatus === "ready");
    }, "Boss来源核验已结束，请查看状态");
  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>独立采集会话</DialogTitle>
          <DialogDescription>
            {boss
              ? "此窗口仅供本目标版本使用。核验读取列表与正文，计入已有活动累计额度。"
              : "此窗口仅供本版本采集使用。未登录仍可读取公开内容；关闭窗口不会自动通过核验。"}
          </DialogDescription>
        </DialogHeader>
        {!boss && (
          <TextField
            name="collection-test-url"
            label="公开文章或帖子链接"
            value={url}
            onChange={setUrl}
            description={
              platform === "wechat"
                ? "填写 mp.weixin.qq.com/s 公开文章地址"
                : "填写微博公开帖子地址"
            }
          />
        )}
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            aria-label="记住此版本登录"
            disabled={!caps.canRemember || op.busy}
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          记住此版本登录
        </label>
        {!caps.canRemember && (
          <p className="text-sm text-muted-foreground">
            当前无法安全记住登录，临时会话仍可使用。
          </p>
        )}
        {!caps.available && <p>独立采集窗口需要支持此能力的桌面版。</p>}
        {state && (
          <p role="status">
            {riskBlocked
              ? "风险阻塞：普通继续和重新打开窗口不会解除"
              : boss && state === "verified"
                ? bodyVerified
                  ? "Boss来源正文已核验"
                  : "登录已核验，来源正文待核验"
                : boss && state === "expired"
                  ? "登录已过期，请自行重新登录并核验"
                  : state === "verified"
                    ? "正文已验证；如登录过期或正文不完整，将重新显示待核验"
                    : state === "cleared"
                      ? "此版本登录已清除"
                      : "未验证：关闭窗口不会完成正文核验"}
          </p>
        )}
        <OperationFeedback
          busy={op.busy}
          error={op.error}
          result={op.message}
        />
        <DialogFooter className="flex flex-wrap gap-2">
          <Button
            disabled={op.busy || !caps.available || (!boss && !url)}
            onClick={() =>
              void op.run(async () => {
                const result = await desktop.openCollectionLogin!({
                  scope,
                  platform,
                  accountRef: platform,
                  remember,
                  ...(!boss ? { testUrl: url } : {}),
                });
                setRef(result.sessionRef);
                setState(result.state);
                setBodyVerified(false);
              }, "独立采集窗口已打开，请自行完成登录")
            }
          >
            打开独立采集窗口
          </Button>
          <Button
            variant="outline"
            disabled={
              op.busy ||
              !sessionRef ||
              !active ||
              (!boss && !url) ||
              (boss && riskBlocked)
            }
            onClick={() =>
              boss
                ? void probeBoss(false)
                : void op.run(async () => {
                    const result = await desktop.verifyCollectionSession!({
                      scope,
                      activityId: active!.runId,
                      sessionRef,
                      testUrl: url,
                    });
                    setState(result.state);
                  }, "正文核验已结束，请查看核验状态")
            }
          >
            {boss ? "核验Boss列表与正文" : "验证登录后正文"}
          </Button>
          {boss && riskBlocked && (
            <Button
              variant="outline"
              disabled={op.busy || !sessionRef || !active}
              onClick={() => void probeBoss(true)}
            >
              明确解除风险并重新核验
            </Button>
          )}
          <Button
            variant="outline"
            disabled={op.busy || !sessionRef}
            onClick={() =>
              void op.run(async () => {
                const r = await desktop.clearCollectionSession!({
                  scope,
                  sessionRef,
                });
                if (r.status === "cleanup_pending")
                  throw Error("窗口清理待重试，请再次清除");
                setRef("");
                setState("cleared");
                setRisk(false);
                setBodyVerified(false);
              }, "登录材料与专用窗口已清除")
            }
          >
            清除此登录
          </Button>
        </DialogFooter>
        {!active && (
          <p className="text-sm text-muted-foreground">
            {boss
              ? "请先创建本版本采集活动；暂停活动也可核验，沿用同一累计额度。"
              : "正文验证需本版本活动正在运行，以计入同一累计额度。"}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
