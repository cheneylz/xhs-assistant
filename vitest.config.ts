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
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
