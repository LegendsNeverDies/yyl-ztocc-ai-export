import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel Serverless 配置
  serverExternalPackages: ["pdfjs-dist"],

  // 允许跨域访问API
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET,POST,OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, Authorization" },
        ],
      },
    ];
  },

  // 文件上传大小限制
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
