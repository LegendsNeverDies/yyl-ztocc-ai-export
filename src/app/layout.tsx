import type { Metadata } from "next";
import "./globals.css";
import { NavBar } from "@/components/shared/nav-bar";
import { ToastProvider } from "@/components/shared/toast";

export const metadata: Metadata = {
  title: "万能导入 V2 - 智能多格式批量下单系统",
  description: "基于AI大模型的智能文件解析与批量下单系统",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-[#f7f8fa] antialiased">
        <ToastProvider>
          <NavBar />
          <main className="pt-14">{children}</main>
        </ToastProvider>
      </body>
    </html>
  );
}
