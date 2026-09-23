# Progress

_Last updated: 2026-09-22_

## Current phase

**Phase 0 — Definition.** No code yet. Idea and name are locked; architecture discussion is next.

## Done

- [x] Ideation: explored RAG project directions (research benchmark, vertical apps, dev tools, chatbots) and landed on **RAG as a package**. Path in `docs/DECISIONS.md`.
- [x] Competitive research: incumbents mapped, gaps identified. See `docs/RESEARCH.md`.
- [x] Phase order agreed: library → server mode → template (later amended by D-006: the template is folded into the framework's widget phase).
- [x] Working name chosen: `openRag`. Availability checked across npm / PyPI / GitHub.
- [x] Project folder + docs scaffolded.
- [x] Language decided: **TypeScript-first** (D-005).
- [x] Architecture draft drawn: `openrag-arch.html` (layers, public API, ingestion, data model, retrieval, chat turn, planner, trace, extension points, roadmap).
- [x] README rewritten as a product README (TS API, features, how it works, roadmap). The working-name note now lives only in D-003 and O-4.
- [x] Wider vision recorded: `docs/VISION.md` (a chatbot framework that adapts to each company, built bottom-up). **D-006**: openRag is layer 1, so it also ships `retrieve()`, `asTool()`, namespaces, a grounding signal and an extensible trace. PLAN, README and ARCHITECTURE updated to match.
- [x] `openrag-arch.html` rewritten in plain language. Added: a big-picture framework section, a "who brings what" section, `retrieve()` / `asTool()` / namespaces, a Phase 1–5 roadmap and a glossary. Store/embedder defaults are shown as "M0 decides", and chunk sizes were removed (left to the M0 experiments).
- [x] **A-3 locked (D-007):** the planner is one structured LLM call (action + standalone query + topic shift), plus a small-talk shortcut.
- [x] **A-4 locked (D-008):** abstain uses two gates: a free score check first, then the LLM may say "not found" in the same answer call.
- [x] **TS vs Python research:** TS has everything v1 needs (live TS-only hybrid-search proof). Python is allowed in `eval/` and in the PDF add-on service (D-005 revisited). Findings are in RESEARCH.md, including the 531 MB install weight (→ A-1) and Mastra as a new competitor.
- [x] **A-5 locked (D-009):** `for await` events in core, `toResponse()` for plain SSE, and a `@openrag/ai-sdk` add-on so a frontend can use `useChat`.
- [x] **A-6 locked (D-010):** own versioned JSON trace on every reply, an `@openrag/otel` add-on for dashboards, and a redact option.
- [x] **A-7 locked (D-011): Node only for v1** (Node 22+). Tested Node ✅, Deno ✅, Bun ❌ (crash). Other runtimes get revisited after v1.
- [x] **A-8 locked (D-012):** core package + `@openrag/*` add-ons. Whether the local embedder sits in core or an add-on is decided with A-1 after M0.
- [x] **A-9 locked (D-013):** bring your own key, auto-detected. Our own `LLM` interface in core, backed by AI SDK Core. Separate planner and answer model roles. **A-3 to A-9 are all done.** A-1 and A-2 wait for the M0 experiments.
- [x] **O-2 locked (D-014):** web dev on Next.js first, backend devs supported through the same library. **O-3 locked (D-015):** "the RAG layer built for chatbots", with every claim backed by a measurement.

## Next

- [x] ~~Architecture discussion: A-3…A-9~~ (D-007…D-013). A-1 and A-2 wait for M0
- [x] **M0 practice run on public docs** (Plausible, 133 pages, 51 questions): `experiments/m0/RESULTS.md`. Leaning:
  - store = SQLite (keyword 76% vs Orama 43%, 3.5× smaller)
  - embedder = bge-small-en (gemma-300m more accurate but ~32× slower)
  - chunking = headings, max 256, with a "page › heading" header
  - reranker (ms-marco-MiniLM) likely **on** by default, because plain RRF hurt paraphrase questions
  - a score-only abstain gate is weak
- [ ] Re-read `experiments/m0/questions.json` for wording bias
- [x] **Locked from M0:** D-016 (chunking, store, embedder), D-017 (reranker on by default, adaptive fusion), D-018 (abstain gate is weak, LLM carries it)
- [ ] Retest the defaults on a real customer corpus when one is available
- [x] ~~Test weighted RRF~~ (done: repairs hit@5, not top-1 → reranker stays, D-017)
- [ ] Measure API embedders (OpenAI, Voyage) against the local default
- [x] **GitHub: https://github.com/obchain/openrag** (public, account `obchain`). `main` holds the README only; `dev` exists **locally** and is not pushed yet
- [ ] Decide what gets pushed to `dev` (planning docs, M0 experiments) before publishing them
- [ ] Resolve remaining open decisions (below)
- [ ] Turn PLAN.md draft milestones into concrete, sized milestones

## Open decisions

| # | Question | Options | Leaning |
|---|---|---|---|
| ~~O-1~~ | ~~Language~~ | — | ✅ **TypeScript-first** (D-005) |
| ~~O-2~~ | ~~Target developer~~ | — | ✅ **Web dev on Next.js first, backend devs supported** (D-014) |
| ~~O-3~~ | ~~Positioning~~ | — | ✅ **"The RAG layer built for chatbots"**: conversations + no servers + tool for agents, each backed by a measurement (D-015) |
| O-4 | Publish name | Keep `openRag` brand w/ free variant (`open-rag`, `openragjs`) · rename (AnyRAG, PureRAG, CoreRAG…) | Must decide before first publish |
| ~~O-5~~ | ~~Default models~~ | — | ✅ LLM access (D-013), embedder `bge-small-en` (D-016). Planner/answer model still to pick |
| ~~O-6~~ | ~~Default vector store~~ | — | ✅ **SQLite + sqlite-vec + FTS5** (D-016) |
| A-1…A-9 | Architecture decisions | — | ✅ A-3 (D-007), A-4 (D-008), A-5 (D-009), A-6 (D-010), A-7 (D-011), A-1…A-9 all locked (D-007…D-013, D-016). Rest: table in `openrag-arch.html` → "Open decisions". A-1, A-2 settled by the M0 experiments |
| O-7 | Framework: open source, SaaS or open core | — | Not blocking Phase 1 (`VISION.md`) |
| O-8 | Framework target customer | Small businesses · enterprises | Not blocking Phase 1 |
| O-9 | Framework name (openRag stays the name of the RAG layer only) | — | Not blocking Phase 1 |

## Blockers

None.
