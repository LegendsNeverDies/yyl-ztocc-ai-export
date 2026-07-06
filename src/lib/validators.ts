import type { OrderRow, ValidationError } from "@/types";

export function validateOrders(rows: OrderRow[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const phoneRegex = /^1[3-9]\d{9}$/;

  for (const row of rows) {
    const ri = row.rowIndex;

    // A组/B组二选一必填
    const hasGroupA = !!row.storeName?.trim();
    const hasGroupB =
      !!row.receiverName?.trim() &&
      !!row.receiverPhone?.trim() &&
      !!row.receiverAddress?.trim();

    if (!hasGroupA && !hasGroupB) {
      errors.push({
        rowIndex: ri,
        field: "storeName",
        message: "A组(收货门店)或B组(收件人姓名/电话/地址)至少填写一组",
      });
    }

    // 必填字段
    if (!row.skuCode?.trim()) {
      errors.push({ rowIndex: ri, field: "skuCode", message: "SKU物品编码为必填项" });
    }
    if (!row.skuName?.trim()) {
      errors.push({ rowIndex: ri, field: "skuName", message: "SKU物品名称为必填项" });
    }
    if (row.skuQuantity == null || row.skuQuantity <= 0 || isNaN(Number(row.skuQuantity))) {
      errors.push({ rowIndex: ri, field: "skuQuantity", message: "SKU发货数量必须为正数" });
    }

    // 电话格式校验
    if (row.receiverPhone?.trim() && !phoneRegex.test(row.receiverPhone.trim())) {
      errors.push({ rowIndex: ri, field: "receiverPhone", message: "收件人电话格式不正确" });
    }
  }

  return errors;
}

export function validateSingleRow(row: OrderRow): ValidationError[] {
  return validateOrders([row]);
}

// 外部编码与「数据库已存在」的冲突检测。
// 注意：同批次内同编码是正常的（按编码聚合的多 SKU 行），不再视为重复。
export function checkExternalCodeDuplicates(
  rows: OrderRow[],
  existingCodes?: Set<string>
): ValidationError[] {
  const errors: ValidationError[] = [];
  if (!existingCodes || existingCodes.size === 0) return errors;

  const reported = new Set<string>();
  for (const row of rows) {
    const code = row.externalCode?.trim();
    if (!code || reported.has(code)) continue;
    if (existingCodes.has(code)) {
      reported.add(code);
      errors.push({
        rowIndex: row.rowIndex,
        field: "externalCode",
        message: `外部编码"${code}"已存在于数据库中`,
      });
    }
  }

  return errors;
}

// 同一外部编码下，收货信息（门店/收件人/电话/地址）必须一致。
// 任一字段在组内出现 ≥2 种非空值，则对该组所有行的该字段标错。
export function checkReceiverConsistency(rows: OrderRow[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const fields: { key: keyof OrderRow; label: string }[] = [
    { key: "storeName", label: "收货门店" },
    { key: "receiverName", label: "收件人姓名" },
    { key: "receiverPhone", label: "收件人电话" },
    { key: "receiverAddress", label: "收件人地址" },
  ];

  const groups = new Map<string, OrderRow[]>();
  for (const row of rows) {
    const code = row.externalCode?.trim();
    if (!code) continue; // 无外部编码的行独立成单，不参与一致性校验
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code)!.push(row);
  }

  for (const [code, group] of groups) {
    if (group.length < 2) continue;
    for (const f of fields) {
      const values = new Set<string>();
      for (const r of group) {
        const v = String(r[f.key] ?? "").trim();
        if (v) values.add(v);
      }
      if (values.size > 1) {
        for (const r of group) {
          errors.push({
            rowIndex: r.rowIndex,
            field: f.key as string,
            message: `外部编码"${code}"下${f.label}不一致，请统一后再提交`,
          });
        }
      }
    }
  }

  return errors;
}
