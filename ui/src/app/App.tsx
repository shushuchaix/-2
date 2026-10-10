import { useEffect, useState } from "react";
import { CSPProvider } from "@base-ui/react/csp-provider";
import {
  LayoutDashboard,
  Briefcase,
  Send,
  FileText,
  Target,
  Globe,
  ScrollText,
  Trash2,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ApiClient, DesktopAdapter } from "../lib/types";
import { VersionProvider, useVersionContext } from "./VersionContext";
import { CollectionProvider, useCollectionActivity } from "./CollectionContext";
import { deriveActivityView } from "../features/workbench/activity-view";
import { parseRoute, buildHash, type Page } from "./router";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
} from "../components/ui/sidebar";
import { TooltipProvider } from "../components/ui/tooltip";
import { Toaster } from "../components/ui/toast";
import { TargetPicker } from "../components/TargetPicker";
import { FormFeedback } from "../components/FormFeedback";
import { ScopeNotice } from "../components/ScopeNotice";
import { ProfilesPage } from "../features/profiles/ProfilesPage";
import { TargetsPage } from "../features/targets/TargetsPage";
import { WorkbenchPage } from "../features/workbench/WorkbenchPage";
import { JobsPage } from "../features/jobs/JobsPage";
import { ApplicationsPage } from "../features/applications/ApplicationsPage";
import { SourcesPage } from "../features/sources/SourcesPage";
import { LogsPage } from "../features/logs/LogsPage";
import { TrashPage } from "../features/trash/TrashPage";
import { SettingsPage } from "../features/settings/SettingsPage";
const navigation: { label: string; items: [Page, string, LucideIcon][] }[] = [
  {
    label: "日常求职",
    items: [
      ["workbench", "工作台", LayoutDashboard],
      ["jobs", "岗位库", Briefcase],
      ["applications", "投递进度", Send],
    ],
  },
  {
    label: "求职准备",
    items: [
      ["profiles", "简历管理", FileText],
      ["targets", "求职目标", Target],
      ["sources", "招聘来源", Globe],
    ],
  },
  {
    label: "系统管理",
    items: [
      ["logs", "运行日志", ScrollText],
      ["trash", "回收站", Trash2],
      ["settings", "设置", Settings],
    ],
  },
];
function Shell({ api, desktop }: { api: ApiClient; desktop: DesktopAdapter }) {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const version = useVersionContext();
  const collection = useCollectionActivity();
  const activityView = deriveActivityView(collection.activity, null);
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const current = version.targets.find(
    (t) => t.packageId === version.scope?.packageId,
  );
  const title = navigation
    .flatMap((g) => g.items)
    .find((i) => i[0] === route.page)?.[1];
  const content = {
    workbench: <WorkbenchPage api={api} />,
    jobs: <JobsPage api={api} />,
    applications: <ApplicationsPage api={api} />,
    profiles: <ProfilesPage api={api} />,
    targets: <TargetsPage api={api} />,
    sources: <SourcesPage api={api} desktop={desktop} />,
    logs: <LogsPage api={api} />,
    trash: <TrashPage api={api} />,
    settings: <SettingsPage api={api} desktop={desktop} />,
  }[route.page];
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="workspace-brand">
          <p className="text-lg font-semibold">简历岗位雷达</p>
          <p className="workspace-brand-description">个人求职工作台</p>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="主要导航">
            {navigation.map((group) => (
              <SidebarGroup key={group.label}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {group.items.map(([page, label, Icon]) => (
                      <SidebarMenuItem key={page}>
                        <SidebarMenuButton
                          isActive={route.page === page}
                          render={
                            <a
                              aria-current={
                                route.page === page ? "page" : undefined
                              }
                              href={buildHash({
                                page: page as Page,
                                selection: version.selection,
                                filters:
                                  route.page === page ? route.filters : {},
                              })}
                            />
                          }
                        >
                          <Icon aria-hidden="true" />
                          <span>{label}</span>
                          {page === "trash" && version.trashCount !== null && (
                            <span
                              aria-hidden="true"
                              className="workspace-nav-count ml-auto"
                            >
                              {version.trashCount}
                            </span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="workspace-header flex min-w-0 flex-wrap items-center gap-4">
          <div className="workspace-decoration" aria-hidden="true" />
          <SidebarTrigger aria-label="切换导航" />
          <div className="workspace-version min-w-0 flex-1">
            <p className="workspace-eyebrow">
              {version.allTargets ? "全部目标 · 只读汇总" : "当前目标版本"}
            </p>
            <p className="workspace-version-name">
              {current?.versionName ??
                (version.allTargets ? "全部目标" : "准备好下一步求职")}
            </p>
            <p className="workspace-version-description">
              {current
                ? "简历副本 · " +
                  String(
                    current.profileSnapshot?.profile?.name ?? "独立简历副本",
                  )
                : version.allTargets
                  ? "选择一个目标版本后，可更新岗位与投递进度。"
                  : "选择目标版本，开始检索适合的岗位。"}
            </p>
          </div>
          <TargetPicker />
          <section
            aria-label="当前版本任务"
            className="w-full text-sm text-muted-foreground"
          >
            {version.allTargets
              ? "全部目标只读汇总"
              : !version.scope
                ? "选择目标版本后查看任务"
                : collection.loading && !collection.activity
                  ? "正在读取任务…"
                  : activityView.label}
            {collection.error && (
              <span role="status">
                {" "}
                · 任务读取失败
                {collection.lastFetchedAt
                  ? "，保留最后成功读取的状态（" +
                    new Date(collection.lastFetchedAt).toLocaleTimeString() +
                    "）"
                  : ""}
              </span>
            )}
          </section>
        </header>
        <section
          id="main-content"
          className="page-content flex min-w-0 flex-col gap-6 p-6"
        >
          {["workbench", "jobs", "applications"].includes(route.page) && (
            <h1>{title}</h1>
          )}
          <FormFeedback error={version.error} />
          {["workbench", "jobs", "applications"].includes(route.page) && (
            <ScopeNotice />
          )}
          <div
            key={
              route.page +
              ":" +
              (["workbench", "jobs", "applications", "logs"].includes(
                route.page,
              )
                ? version.generation
                : 0)
            }
          >
            {content}
          </div>
        </section>
      </SidebarInset>
    </SidebarProvider>
  );
}
export function App(props: { api: ApiClient; desktop: DesktopAdapter }) {
  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <VersionProvider api={props.api}>
          <CollectionProvider api={props.api}>
            <Shell {...props} />
          </CollectionProvider>
        </VersionProvider>
        <Toaster />
      </TooltipProvider>
    </CSPProvider>
  );
}
