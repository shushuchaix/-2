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
  onClose,
}: {
  api: ApiClient;
  desktop: DesktopAdapter;
  scope: Scope;
  platform: "wechat" | "weibo";
  onClose(): void;
}) {
  const [caps, setCaps] = useState({ available: false, canRemember: false }),
    [url, setUrl] = useState(""),
    [remember, setRemember] = useState(false),
    [sessionRef, setRef] = useState(""),
    [state, setState] = useState("");
  const op = useOperation();
  const roots = useQuery<{ collections?: CollectionActivity[] }>(
      api,
      "/collections",
      scope,
    ),
    active = roots.data?.collections?.find(
      (a) => a.collectionProgress.status === "collecting",
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
            此窗口仅供本版本采集使用。未登录仍可读取公开内容；关闭窗口不会自动通过核验。
          </DialogDescription>
        </DialogHeader>
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
            {state === "verified"
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
            disabled={op.busy || !caps.available || !url}
            onClick={() =>
              void op.run(async () => {
                const result = await desktop.openCollectionLogin!({
                  scope,
                  platform,
                  accountRef: platform,
                  remember,
                  testUrl: url,
                });
                setRef(result.sessionRef);
                setState(result.state);
              }, "独立采集窗口已打开，请自行完成登录")
            }
          >
            打开独立采集窗口
          </Button>
          <Button
            variant="outline"
            disabled={op.busy || !sessionRef || !active || !url}
            onClick={() =>
              void op.run(async () => {
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
            验证登录后正文
          </Button>
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
              }, "登录材料与专用窗口已清除")
            }
          >
            清除此登录
          </Button>
        </DialogFooter>
        {!active && (
          <p className="text-sm text-muted-foreground">
            正文验证需本版本活动正在运行，以计入同一累计额度。
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
