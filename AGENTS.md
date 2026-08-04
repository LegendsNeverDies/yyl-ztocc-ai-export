<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 2026060502 — 万能导入 V2 (Universal Import V2)

This is the **V2** project of the waybill-import monorepo (the other half is `../2026060503/` = V3 "运单全流程管理系统"). V2 is an AI-driven multi-format batch order-importer: upload an Excel/PDF → pick or AI-generate a **parse rule** → parse to normalized `OrderRow`s → validate/preview/edit → submit to Neon Postgres. It also exposes an external HTTP API (`/api/external/waybills/*`) that V3 consumes.

## Where the real documentation is

- **`CLAUDE.md`** (this folder) — the full V2 guide: commands, pipeline, parse modes, DB schema, conventions. **Read it before changing V2 code.**
- **`../CODEBUDDY.md`** — monorepo-wide overview of both V2 and V3, their shared conventions, env vars, and the V2↔V3 link.
- **`../2026060503/README.md`**, **`API_CONTRACT.md`**, **`ASSUMPTIONS.md`** — V3 specifics and the interface contract between the two projects.

## Essential commands

```bash
npm run dev        # Next.js dev server (port 3000)
npm run build      # production build (also the Vercel build command)
npm run lint       # eslint flat config (eslint.config.mjs)

npm run db:seed                # seed the 6 built-in parse rules (src/lib/seed-rules.ts)
npx tsx scripts/seed-shipments.ts   # generate shipments WB10001–WB10010 (run before V3 can validate locally)
npx tsx scripts/gen-1000.ts         # regenerate the root 1000条测试运单.xlsx (uses xlsx)
npx tsx scripts/verify-scenarios.ts # static scenario checklist — prints expectations, NOT a runnable test
```

There is **no test runner** in either project. Verify behavior by running the dev server against the sample files in `demos/`.

## Non-obvious facts a future instance must know

- `ParseRule` is a JSONB `config` blob stored in `parse_rules` (only `name`/`description` are real columns); `getRule`/`getAllRules` spread `config` back over the row. The 6 built-in rules in `src/lib/seed-rules.ts` map 1:1 to the files in `demos/` (standard/aggregate/matrix/card/multi-sheet/PDF) — read the matching seed rule before writing a new one for a similar layout.
- **File reading and parsing run in the browser**, not the server. Pages hand data between each other via `sessionStorage` (keys `previewData`, `newRuleFile`). Only DB access and AI calls cross to the server.
- `submitOrders` uses Neon HTTP (stateless): it inserts shipments (batched 100) then orders (batched 500), **not** in a single transaction — a mid-way failure can orphan shipments without orders.
- V2's `EXTERNAL_API_KEY` (env) must equal V3's `V2_API_KEY`. The PDF worker is served locally from `public/pdf.worker.min.mjs`; **after upgrading `pdfjs-dist`, re-copy it**: `cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs public/`.
- Code/comments/UI copy are Chinese — match that. Teal accent `#0fc6c2`. Path alias `@/*` → `src/*`.
