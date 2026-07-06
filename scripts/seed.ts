import { config } from "dotenv";
config({ path: ".env.local" });

async function main() {
  // 动态 import 确保 dotenv 先加载再初始化 db 模块
  const { seedDemoRules } = await import("../src/lib/seed-rules");
  console.log("正在初始化内置解析规则...");
  const count = await seedDemoRules();
  console.log(`✅ 完成：已写入 ${count} 条内置规则`);
}

main().catch((e) => {
  console.error("❌ 初始化失败:", e);
  process.exit(1);
});
