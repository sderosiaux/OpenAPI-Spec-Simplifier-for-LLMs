# Spec / Slim

Turn OpenAPI and Swagger documents into focused context for LLMs. Paste on the left, copy compact context on the right. A browser-only tool with automatic conversion and Max compression by default.

## Run locally

Use Node.js **22.18+** (or Node.js **24 LTS**).

```sh
npm ci
npm run dev
```

Open the local URL printed by Vite. To preview the production build:

```sh
npm run build
npm run preview
```

The app now has a build step; opening `index.html` directly is no longer supported. GitHub Pages builds and deploys `dist/` through the included workflow. Relative asset URLs also support repository subpaths.

## Use the workbench

- Paste a spec, import a `.json`, `.yaml`, or `.yml` file, or drop one into the source editor. Files are limited to 5 MB.
- **Max** compression runs automatically. The settings icon opens presets (**Compact**, **Balanced**, **Readable**) and controls for descriptions, schema notation, examples, and unused schemas.
- In Settings, filter operations by method, path, operation ID, summary, or tag. The included schemas follow the selected operations and their transitive dependencies.
- Copy the output directly. JSON export, download, and source formatting are available in Settings. Use **⌘/Ctrl + Enter** to refresh immediately; edits otherwise update automatically.

The page starts empty with the source editor ready to paste into. **Try example** opens the bundled e-commerce spec when needed. The main view shows only the editors, Upload / Try example, Copy, and the size reduction. Clear appears when there is input; errors and conversion notes appear only when needed. Imported specs are never persisted; only preferences are stored locally. Parsing and formatting run in a Web Worker. Fonts and dependencies are bundled, with no analytics, external font requests, or remote processing.

| Preset        | Description limit | Text encoding                             | Examples |
| ------------- | ----------------- | ----------------------------------------- | -------- |
| Max (default) | None              | Shared definitions + short schema aliases | Omitted  |
| Compact       | None              | Shared definitions + full schema names    | Omitted  |
| Balanced      | 120 characters    | Expanded operations, compact schemas      | Omitted  |
| Readable      | 300 characters    | Expanded operations, explicit schemas     | Included |

All presets retain supported contract fields; compact mode does not silently drop non-200 responses, parameter locations, or security requirements.

## Output and boundaries

Supported inputs: **OpenAPI 3.0 / 3.1** and **Swagger 2.0**, in JSON or YAML. The parser checks the version and document shape; it is **not a full OpenAPI validator**.

Preserved information includes path and operation parameters, request bodies, media types, response codes (including `default` and ranges), response headers, server overrides, authentication requirements, schema constraints, nullability, boolean schemas, and `oneOf` / `anyOf` / `allOf`. Local JSON Pointer references are resolved; recursive schemas remain symbolic. Referenced discriminator mappings are included.

LLM text uses `!` for required fields and `str`, `int`, `num`, and `bool` for primitive types. Compact and Max use unmarked optional fields, `[T]` for arrays, `A|B` for `anyOf`, and `closed` for `additionalProperties: false`. `oneOf` and `allOf` remain distinct. Max maps short schema aliases back to their full names in the schema section (for example, `@0 HealthResponse=...`). `$p`, `$r`, and `$s` definitions share repeated parameters, responses, and status-code groups. Common headers are lifted only when they occur identically in every response. Readable and Balanced use `?` for optional fields and named schema references. These compression encodings apply to LLM text. JSON export keeps the normalized structure and is therefore usually larger. It is parseable JSON with internal `#/schemas/...` references, but **is not an OpenAPI document**. Keep the source for validation and code generation.

Documentation metadata, vendor extensions, schema titles, XML serialization annotations, callbacks, top-level webhooks, and response links are omitted. The UI flags omitted callbacks/webhooks/links and unresolved references. External references are never fetched. Bundle multi-file specs before importing. Advanced JSON Schema identifiers, anchors, and dynamic reference semantics are not resolved; identifiers and dynamic references are retained with a note.

The engine exposes **rough token estimates** (`characters ÷ 4`), not model-specific tokenization; these are omitted from the main interface. Size reduction uses UTF-8 bytes and compares the output with the input as pasted, including its whitespace. Filtering also affects reduction. Small specs can grow; the interface reports that accurately.

## Development and checks

```sh
npm test                     # Engine regression tests
npm run build                # Strict TypeScript check + production build
npx playwright install chrome # One-time browser setup if Chrome is not installed
npm run test:e2e              # Browser flows, mobile layout, and axe checks
npm run check                # Formatting + all checks above
npm run format               # Format maintained source files
npm run benchmark            # Compare presets on the pinned Nevia fixture
npm run benchmark -- api.yaml # Compare presets on your own spec
```

- `src/model.ts`: shared types, presets, and size helpers.
- `src/simplifier.ts`: parsing, reference handling, transformation, and text serialization.
- `src/compact.ts`: dense output, shared definitions, and schema aliases.
- `src/worker.ts`: background parsing and formatting.
- `src/main.ts`: interface state, rendering, import, copy, and download.
- `src/styles.css`: responsive visual design and accessibility states.
- `tests/`: engine regressions and Playwright browser coverage.

The workflow checks pull requests and main-branch changes. Only successful main-branch builds deploy to GitHub Pages; enable **GitHub Actions** as the Pages source in repository settings.

## Compression regression fixture

`tests/fixtures/nevia.openapi.yaml.gz` is a compressed snapshot of [Nevia's public OpenAPI spec](https://nevia.cloud/openapi.yaml), retrieved on 2026-10-15. Its SHA-256 and the legacy Nightmare baseline are recorded in `nevia.metadata.json`. Tests decompress it locally and enforce a **less-than-2% output size budget** for Max while retaining all **58 operations and 104 schemas**. No test fetches the live endpoint.

On this snapshot: original **819,510 bytes**; legacy Nightmare **12,557 characters (98.47% smaller)**; Max approximately **16 KB (98% smaller)**. Max additionally retains response codes, headers, parameter locations, operation IDs, and validation constraints that the legacy output discarded. This is a size benchmark, not measured model tokenization.

## Suggested next improvements

1. **Exact token counts on demand.** Lazy-load a model-specific tokenizer and compare presets against a chosen context budget. Keep this optional and out of the main paste-and-copy flow.
2. **Semantic validation and a retention report.** Show precisely which fields were kept, shortened, or removed; add full OpenAPI validation and coverage for newer spec versions.
3. **Multi-file import.** Resolve external references from a user-selected folder or ZIP entirely on-device, with explicit handling for missing files.
4. **CLI and CI integration.** Reuse the pure engine to generate checked-in agent context and fail CI when an API context budget is exceeded.
5. **Task-based operation selection.** Add selectable tags and endpoints with a preview of their schema dependencies, building on the current text filter.
