"use client";
/**
 * 认证守卫（对应原版 ProtectedRoute / PublicOnlyRoute，react-router Navigate → next/navigation）
 */
import { Spin } from "antd";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useAuth } from "@/hooks/use-auth";

type RouteGuardProps = {
  children: ReactNode;
};

function CheckingSpin() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        background: "#f5f5f5",
      }}
    >
      <Spin size="large" tip="正在验证登录状态..." />
    </div>
  );
}

/** 需要登录的页面守卫（未登录跳转 /login） */
export function ProtectedRoute({ children }: RouteGuardProps) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!auth.isChecking && !auth.isAuthenticated) {
      router.replace("/login");
    }
  }, [auth.isChecking, auth.isAuthenticated, router]);

  if (auth.isChecking) {
    return <CheckingSpin />;
  }
  if (!auth.isAuthenticated) {
    return null;
  }
  return <>{children}</>;
}

/** 仅匿名可访问的页面守卫（已登录跳转小红书工作区） */
export function PublicOnlyRoute({ children }: RouteGuardProps) {
  const auth = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!auth.isChecking && auth.isAuthenticated) {
      router.replace("/platforms/xhs/dashboard");
    }
  }, [auth.isChecking, auth.isAuthenticated, router]);

  if (auth.isChecking) {
    return <CheckingSpin />;
  }
  if (auth.isAuthenticated) {
    return null;
  }
  return <>{children}</>;
}
