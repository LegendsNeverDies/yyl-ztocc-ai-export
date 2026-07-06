# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

> ⚠️ Per AGENTS.md: this is Next.js **16.2.6** with breaking changes vs. older versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing framework code, and heed deprecation notices.

## What this is

"万能导入 V2" (Universal Import V2) — an intelligent multi-format batch order-import system. A user uploads an arbitrary Excel/PDF outbound-shipping document, picks (or AI-generates) a **parse rule**, the file is parsed into normalized order rows, validated, previewed/edited, then submitted to the database.

## Commands

```bash
npm run dev          # Next.js dev server
npm run build        # production build (also Vercel build command)
npm run lint         # eslint flat config (eslint.config.mjs)

npm run db:generate  # drizzle-kit: generate SQL migrations from db-schema.ts
npm run db:push      # push schema to the Neon Postgres DB
npm run db:seed      # run scripts/seed.ts → seedDemoRules() (writes 6 built-in rules)
npm run db:studio    # drizzle-kit studio
```

There is no test runner configured. `scripts/verify-scenarios.ts` is a static checklist (prints expectations for each demo file), not a real test. To verify parsing, run the dev server against the sample files in `demos/`. `scripts/gen-1000.ts` regenerates the root `1000条测试运单.xlsx` (uses `xlsx`, not exceljs).

### Environment (`.env.local`, not committed)

- `DATABASE_URL` — Neon Postgres connection string (required by db, drizzle.config.ts).
- `DEEPSEEK_API_URL` — chat-completions endpoint. DeepSeek and StepFun both work (ai-client branches on `deepseek.com` / `stepfun.com` to attach `response_format`). **No default — missing throws.**
- `DEEPSEEK_API_KEY` — **required, missing throws.** Trailing quotes/whitespace are stripped defensively (copy-paste 401s).
- `DEEPSEEK_MODEL` — **required, missing throws** (e.g. `deepseek-chat`, `step-3.7-flash`).

AI calls send `temperature: 0.1`, `max_completion_tokens: 4096`, `thinking: { type: "disabled" }`. StepFun deep-thinking may return content in `message.reasoning_content` — `ai-client` falls back to it when `content` is empty.

## Architecture

### Pipeline (the big picture)

`upload → select/generate rule → parse → validate → preview/edit → submit`

Steps are driven from `src/app/page.tsx` and connected pages. **File reading and parsing run in the browser**, not the server — data is handed between pages via `sessionStorage` (keys: `previewData`, `newRuleFile`). Only DB access and AI calls cross to the server.

- **File reading** (`src/lib/file-reader.ts`): `readFile()` dispatches by extension. Excel via `xlsx` (every cell stringified, blank rows dropped, multi-sheet workbooks populate `sheets`). PDF via `pdfjs-dist`: text fragments are clustered into lines by `(page, y)`, then a column-anchor grid is computed from all `x` values so fragments snap to columns — output is an aligned `RawRow[]` grid just like Excel. The PDF worker is served **locally** from `/pdf.worker.min.mjs` (in `public/`) — **after upgrading `pdfjs-dist`, re-copy it**: `cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/`.
- **Parse engine** (`src/lib/parse-engine.ts`): the core. `parseFile(file, rule)` turns raw rows into `OrderRow[]` per the rule's `parseMode`. See the modes below.
- **Validation** (`src/lib/validators.ts`): `validateOrders` (A-group `storeName` OR B-group `receiverName`+`receiverPhone`+`receiverAddress` required; `skuCode`/`skuName`/positive `skuQuantity` required; CN phone regex), `checkExternalCodeDuplicates` (in-batch same code is **not** a duplicate now — multiple SKU rows under one code is the normal aggregate case; only flags codes already in the DB), `checkReceiverConsistency` (rows sharing one `externalCode` must agree on store/receiver/phone/address), plus `validateSingleRow`.
- **Persistence** (`src/lib/server-actions.ts`, `"use server"`): rule CRUD + `submitOrders(rows, batchId)` + `getShipmentsPage` (paginated/filtered main-table query) + `getShipmentDetail` (SKU items for one shipment). `getExistingExternalCodes` feeds dedup.

### Parse modes (`ParseMode` in `src/types/index.ts`)

A rule (`ParseRule`) selects one mode; the engine has a dedicated function per mode:

- **standard** — row-per-record table. `excel.dataStartRow/footerRows/skipRows/skipIfFirstColContains` bound the data region; `fieldMappings` map column index → field.
- **aggregate** — multiple rows under one code; parses as standard, then groups by `aggregate.groupByField` and back-fills `sharedFields` from the first non-empty value in each group.
- **matrix** — store×SKU grid: `matrix.fixedColMappings` read SKU columns; store names come from `storeHeaderRow` across `storeStartCol..storeEndCol`; one `OrderRow` per nonzero quantity cell.
- **card** — card-style layout with a `boundaryPattern` regex resetting per-card meta; `cardMetaMappings` scan KV labels, `dataFieldMappings` read the item rows.
- **multi-sheet** — each sheet parsed independently (as standard) and concatenated.

Cross-cutting: **KV extraction** (`kvExtract`) scans label cells (e.g. `收货人：`) for header/footer metadata not in the table grid — supports both same-cell `label：value` and label-alone-with-value-in-next-column. Row offsets are positive-from-`dataStartRow` or negative-from-end; empty/omitted `rows` = scan all rows (good for PDF's scattered info).

`OrderRow` is the canonical normalized shape (10 business fields + `id`/`rowIndex`/`_errors`). Field resolution prefers mapped value → rule `defaults` → KV value.

**Best reference for each mode**: the 6 built-in rules in `src/lib/seed-rules.ts` map 1:1 to the files in `demos/` (standard/aggregate/matrix/card/multi-sheet/PDF). Read the matching seed rule before writing a new one for a similar layout.

### Rules are data, generated by AI

A `ParseRule` is persisted as a JSONB `config` blob in `parse_rules` (only `name`/`description` are real columns — see `src/lib/db-schema.ts`). `getRule`/`getAllRules` spread `config` back over the row.

- **AI generation** (`src/lib/ai-client.ts` via `POST /api/ai/analyze`): sends a sampled prompt (first ~50 rows + last 10) to the chat API and expects a strict JSON `AiRuleResponse`. `extractJson` is defensive — it strips ```` ```json ```` fences and falls back to first-`{`…last-`}`. The system prompt enumerates the allowed `toField` names and mode semantics; keep it in sync with `src/types/index.ts` and the parse engine when changing the schema.
- **Built-in rules**: `src/lib/seed-rules.ts`, seeded via `npm run db:seed` or `POST /api/rules/seed`. `seedDemoRules` deletes same-named rules first, then re-inserts.

### Database — 主子表 (master + detail)

Drizzle ORM over **Neon serverless HTTP** (`src/lib/db.ts`, `drizzle-orm/neon-http`). Three tables (schema in `src/lib/db-schema.ts`; `drizzle.config.ts` loads `.env.local` via dotenv):

- `parse_rules` — rules (JSONB `config` blob, only `name`/`description` are real columns).
- `shipments` — 出库单主表. **One row per `externalCode`** (rows with no external code each become their own shipment). Carries receiver/store info plus redundant `skuCount`/`totalQuantity` for list display, and `batchId` per submission.
- `orders` — SKU 明细子表, `shipment_id` FK → `shipments.id` with `onDelete: "cascade"`.

`submitOrders` groups rows by `externalCode`, inserts shipments (batched 100) then orders (batched 500) — shipments must succeed first because of the FK. Note: the two inserts are **not** in a single transaction (Neon HTTP is stateless); a mid-way failure can leave shipments without orders.

### Conventions

- Path alias `@/*` → `src/*`.
- UI: Tailwind v4 (`@tailwindcss/postcss`), `lucide-react` icons, a teal accent (`#0fc6c2`). Shared primitives in `src/components/shared/`; `cn()` (clsx + tailwind-merge) in `src/lib/utils.ts`. The preview page virtualizes large tables with `@tanstack/react-virtual`.
- Code, comments, and UI copy are in Chinese — match that.
- Deploy target is Vercel (`vercel.json`, region `hkg1`); `next.config.ts` marks `pdfjs-dist` as a server-external package, opens CORS on `/api/*`, and raises the Server Action body limit to 10mb.
