import { pgTable, uuid, varchar, text, numeric, integer, timestamp, jsonb } from "drizzle-orm/pg-core";

export const parseRules = pgTable("parse_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// 出库单主表：按外部编码聚合，存收货信息与冗余汇总
export const shipments = pgTable("shipments", {
  id: uuid("id").defaultRandom().primaryKey(),
  externalCode: varchar("external_code", { length: 255 }),       // 可空（无外编码时每行独立成单）
  storeName: varchar("store_name", { length: 255 }),
  receiverName: varchar("receiver_name", { length: 255 }),
  receiverPhone: varchar("receiver_phone", { length: 50 }),
  receiverAddress: text("receiver_address"),
  remark: text("remark"),
  skuCount: integer("sku_count").notNull().default(0),           // 明细行数（冗余，列表展示用）
  totalQuantity: numeric("total_quantity").notNull().default("0"), // 总数量（冗余）
  batchId: uuid("batch_id").notNull(),
  submittedAt: timestamp("submitted_at").defaultNow(),
});

// SKU 明细子表：关联到 shipments
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().primaryKey(),
  shipmentId: uuid("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  skuCode: varchar("sku_code", { length: 255 }).notNull(),
  skuName: varchar("sku_name", { length: 500 }).notNull(),
  skuQuantity: numeric("sku_quantity").notNull(),
  skuSpec: varchar("sku_spec", { length: 500 }),
  remark: text("remark"),
});
