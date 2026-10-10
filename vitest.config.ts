import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** vitest 配置：仅跑 src 下的单元测试（审校规则引擎、文案包解析等纯函数） */
export default defineConfig({
  resolve: {
    alias: {
      // 对齐 tsconfig paths：@/* → src/*
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // tsconfig 的 jsx:preserve 会被 esbuild 退化成经典运行时（React.createElement），
  // 组件测试（.tsx）在 node 下会报 React is not defined；自动运行时与 Next.js 的实际编译一致
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
