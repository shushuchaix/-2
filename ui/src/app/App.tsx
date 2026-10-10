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
        <SidebarHeader>
          <p className="text-lg font-semibold">简历岗位雷达</p>
          <p className="text-sm text-muted-foreground">个人求职工作台</p>
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
                              className="ml-auto rounded-md bg-muted px-2 text-sm"
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
        <header className="flex min-w-0 flex-wrap items-center gap-4 border-b bg-card p-4">
          <SidebarTrigger aria-label="切换导航" />
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">
              {current
                ? current.versionName +
                  " / " +
                  String(
                    current.profileSnapshot?.profile?.name ?? "独立简历副本",
                  )
                : "准备好下一步求职"}
            </p>
          </div>
          <TargetPicker />
        </header>
        <main
          id="main-content"
          className="page-content flex min-w-0 flex-col gap-6 p-6"
        >
          {["workbench", "jobs", "applications"].includes(route.page) && (
            <h1 className="text-2xl font-semibold">{title}</h1>
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
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
export function App(props: { api: ApiClient; desktop: DesktopAdapter }) {
  return (
    <CSPProvider disableStyleElements>
      <TooltipProvider>
        <VersionProvider api={props.api}>
          <Shell {...props} />
        </VersionProvider>
        <Toaster />
      </TooltipProvider>
    </CSPProvider>
  );
}
