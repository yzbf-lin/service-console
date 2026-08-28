"use client";

import { Check, Cloud, Monitor, Moon, Sun } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Separator } from "@/components/ui/separator";
import { isSupabaseConfigured } from "@/lib/supabase";
import type { ResolvedTheme, ThemePreference } from "@/lib/types";
import { cn } from "@/lib/cn";

interface SettingsViewProps {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onPreferenceChange: (preference: ThemePreference) => void;
}

const themes = [
  { value: "system" as const, label: "跟随系统", description: "随 macOS 外观自动切换", icon: Monitor },
  { value: "light" as const, label: "浅色", description: "始终使用明亮界面", icon: Sun },
  { value: "dark" as const, label: "深色", description: "始终使用低亮度界面", icon: Moon },
];

export function SettingsView({ preference, resolvedTheme, onPreferenceChange }: SettingsViewProps) {
  const cloudConfigured = isSupabaseConfigured();

  return (
    <main id="settingsView" className="no-visible-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5" aria-labelledby="settingsHeading">
      <div className="mx-auto w-full max-w-3xl space-y-3">
        <div className="mb-5">
          <span className="text-[9px] font-bold tracking-[0.12em] text-primary uppercase">控制台偏好</span>
          <h2 id="settingsHeading" className="mt-1 text-lg font-bold tracking-tight">设置</h2>
          <p className="mt-1 text-xs text-muted-foreground">调整 Service Console 的显示和可选云端连接。</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">外观</CardTitle>
            <CardDescription className="text-xs">主题偏好会保存在本机，应用重启后仍然生效。</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              className="grid grid-cols-3 gap-2 max-[620px]:grid-cols-1"
              value={preference}
              aria-label="主题偏好"
              onValueChange={(value) => onPreferenceChange(value as ThemePreference)}
            >
              {themes.map(({ value, label, description, icon: Icon }) => {
                const selected = preference === value;
                return (
                  <label
                    key={value}
                    className={cn(
                      "relative flex min-h-24 cursor-pointer flex-col rounded-lg border bg-background p-3 outline-none transition-colors hover:bg-accent/45",
                      selected && "border-primary bg-accent/55 ring-1 ring-primary/20",
                    )}
                  >
                    <RadioGroupItem className="sr-only" value={value} />
                    <div className="flex items-center justify-between">
                      <span className={cn("grid size-8 place-items-center rounded-md bg-secondary text-muted-foreground", selected && "bg-primary text-primary-foreground")}>
                        <Icon className="size-4" aria-hidden="true" />
                      </span>
                      {selected ? <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground"><Check className="size-3" /></span> : null}
                    </div>
                    <strong className="mt-2 text-xs">{label}</strong>
                    <small className="mt-0.5 text-[10px] text-muted-foreground">{description}</small>
                  </label>
                );
              })}
            </RadioGroup>
            <p className="mt-3 text-[10px] text-muted-foreground" aria-live="polite">
              当前实际使用：{resolvedTheme === "dark" ? "深色主题" : "浅色主题"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-sm">Supabase 云端连接</CardTitle>
                <CardDescription className="mt-1 text-xs">可选的远程认证与状态同步适配器，不影响本机离线控制。</CardDescription>
              </div>
              <Badge variant={cloudConfigured ? "success" : "secondary"}>{cloudConfigured ? "已配置" : "未配置"}</Badge>
            </div>
          </CardHeader>
          <Separator />
          <CardContent className="flex items-start gap-3 pt-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-muted-foreground"><Cloud className="size-4" aria-hidden="true" /></span>
            <div>
              <strong className="text-xs">本机控制始终直接连接 Service Console</strong>
              <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                Supabase 仅在构建时提供 NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY 后启用。启动、停止、日志和端口操作仍由本机 FastAPI 守护进程执行。
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
