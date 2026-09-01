import type { NextConfig } from "next";

/**
 * Next.js 配置
 * 说明：
 * - 强制 Node.js runtime（签名 SDK 依赖 node:vm 模块，不可部署 Edge）
 * - output: "standalone" 便于 Docker 部署（app + worker 双服务）
 * - optimizePackageImports：antd/icons/recharts 按需转换，避免全量打入页面 chunk
 * - splitChunks 自定义分组：antd/react/recharts 抽成共享 chunk，防止每个页面重复打包
 *   （实测修复前：每个页面 chunk 高达 2.5MB+ gzip，切换 tab 卡顿的根因）
 */
const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // 长任务支持：AI 生图（180s）、大文件上传（100MB）
  experimental: {
    serverActions: {
      bodySizeLimit: "128mb",
    },
    optimizePackageImports: ["antd", "@ant-design/icons", "recharts", "lucide-react"],
  },
  // 签名 SDK 的纯算法 JS 文件随包构建，不做任何转译
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    // 共享依赖分组：antd 生态 / react / recharts，避免每个页面 chunk 重复包含
    if (config.optimization?.splitChunks?.cacheGroups) {
      config.optimization.splitChunks.cacheGroups = {
        ...config.optimization.splitChunks.cacheGroups,
        "react-vendor": {
          test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
          name: "react-vendor",
          chunks: "all",
          priority: 30,
        },
        antd: {
          test: /[\\/]node_modules[\\/](antd|@ant-design|@rc-component|rc-[a-z-]+)[\\/]/,
          name: "antd-vendor",
          chunks: "all",
          priority: 20,
        },
        charts: {
          test: /[\\/]node_modules[\\/](recharts|d3-[a-z-]+|victory-vendor)[\\/]/,
          name: "charts-vendor",
          chunks: "all",
          priority: 15,
        },
        axios: {
          test: /[\\/]node_modules[\\/](axios|follow-redirects|form-data)[\\/]/,
          name: "axios-vendor",
          chunks: "all",
          priority: 12,
        },
      };
    }
    return config;
  },
};

export default nextConfig;
