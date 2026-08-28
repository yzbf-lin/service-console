"use client";

import { useCallback, useEffect, useState } from "react";

const AUTO_SCROLL_STORAGE_KEY = "service-console:auto-scroll";

export function useAutoScrollPreference() {
  // 静态 HTML 固定为开启；挂载后再读取浏览器偏好，保证首帧可水合。
  const [autoScroll, setAutoScrollState] = useState(true);

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      try {
        setAutoScrollState(window.localStorage.getItem(AUTO_SCROLL_STORAGE_KEY) !== "false");
      } catch {
        // localStorage 被禁用时保留默认值。
      }
    }, 0);
    return () => window.clearTimeout(syncTimer);
  }, []);

  const setAutoScroll = useCallback((checked: boolean) => {
    setAutoScrollState(checked);
    try {
      window.localStorage.setItem(AUTO_SCROLL_STORAGE_KEY, String(checked));
    } catch {
      // 偏好持久化失败不应影响日志浏览。
    }
  }, []);

  return [autoScroll, setAutoScroll] as const;
}
