# Plan

_Status: **draft**. Milestones below are a first cut. They get sized and finalized after the architecture discussion._

## Goal

A package that lets any developer ship a chatbot grounded in their own documents with one line of code, and customize every layer when they need to.

openRag is also the first layer of a wider chatbot framework (see `VISION.md`, D-006). So it has to work as a **tool** that other components call, not only as a standalone bot.

## Success criteria

The project is done (v1) when all of these are true and measured, not claimed:

1. **One-line start.** A working bot over a folder of docs in ≤ 3 lines of user code.
2. **Head-to-head vs LlamaIndex** on the same corpus, reported in `eval/results.md`:
   - lines of code to first working bot
   - install size / dependency count
   - answer quality on the same eval set
   - follow-up and unanswerable handling (MTRAG-UN)
   - p50 latency
3. **Honest numbers.** Where openRag loses, the results say so.
4. **Published** under a name we actually own.
5. **Documented** well enough that a stranger gets a bot running from the README alone.
6. **Tool-ready.** `retrieve()` and `asTool()` work from an external agent loop, shown in one example in `examples/`.

## Phases

### Phase 0 — Definition ← current
- Lock idea, name, scope ✅
- Language: TypeScript ✅ (D-005)
- Wider vision recorded ✅ (`VISION.md`, D-006)
- Architecture discussion → `ARCHITECTURE.md`
- Resolve open decisions (target dev, positioning, providers)

### Phase 1 — Library (core)

Draft milestones, in dependency order:

| # | Milestone | Delivers |
|---|---|---|
| M0 | Scaffold | Repo, build, lint, test harness, CI on Node 22+ (D-011), package skeleton |
| M1 | Ingestion | Loaders (files, folders, URLs), parsing, chunking, incremental re-index |
| M2 | Index | Embedded store as default, storage adapter interface, **namespace per tenant** (D-006) |
| M3 | Retrieval | Hybrid (lexical + vector), rerank, metadata filters, **public `retrieve()` with a grounding signal, `asTool()`** (D-006) |
| M4 | Generation | Own `LLM` interface backed by AI SDK Core, BYOK auto-detect (D-013), grounded answers, citations, streaming (`for await` events, `toResponse()`, `@openrag/ai-sdk` add-on: D-009) |
| M5 | Conversation | Sessions, memory, follow-up query rewriting, retrieve-or-not, abstain with a structured reason |
| M6 | Trace + Eval | Per-answer trace (versioned JSON with room for tool calls and approvals, redact option, `@openrag/otel` add-on: D-010), built-in eval CLI, MTRAG-UN run, LlamaIndex baseline |
| M7 | Release | Docs, examples, README, publish |

Level-1 API (`Bot("./docs").ask(...)`) should work end to end as early as M4. After that, each milestone makes the default smarter without changing that line.

### Phase 2 — Server mode
`docker run … serve ./docs` → REST + streaming API over the same core, ready for many tenants through namespaces. A thin layer: no new RAG logic.

### Phases 3–5 — The framework
Long-term direction from `VISION.md`. Each phase starts only after the one before it has shipped.

- **Phase 3: Knowledge tools + router.** SQL, API/OpenAPI and FAQ tools next to openRag, plus a router that picks the right tool(s) for each question.
- **Phase 4: Actions + permissions.** Tools that do things, with permissions enforced in code, an owner approval flow and an audit log.
- **Phase 5: Onboarding + widget + dashboard.** A setup flow that proposes a company config for the owner to approve, an embeddable website widget, and an owner dashboard. This replaces the earlier standalone "template" phase.

## Out of scope for v1

- Hosted / managed service, auth, billing
- Per-user access control (ACL) inside a namespace. Isolation *between* tenants through namespaces is in v1.
- Router, SQL/API tools, actions, onboarding: Phases 3–5
- Multimodal (images, page-image retrieval)
- GraphRAG / knowledge-graph retrieval
- Fine-tuned retrievers

These are candidates for after v1. They're here so we don't drift into them.
