"use client";
/**
 * 受保护区域布局：认证守卫 + AppShell（对应原版 router.tsx 中 ProtectedRoute + AppShell 包裹的路由组）
 */
import { AppShell } from "@/components/layout/app-shell";
import { ProtectedRoute } from "@/components/ui/route-guards";

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute>
      <AppShell>{children}</AppShell>
    </ProtectedRoute>
  );
}
