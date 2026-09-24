# Decisions

Every major decision, with the reasoning and the alternatives we turned down. Newest at the bottom.

---

## D-001: Build RAG as a package, not an app
_2026-09-21 · decided_

**Decision:** openRag is a package (a RAG layer), not an end-user app. Developers build their own chatbot on top; openRag provides retrieval, conversation, and grounding underneath.

**How we got here:** Ideation went through several directions before settling here:
1. Research benchmark (RAG error decomposition on FinanceBench). Rejected: we wanted something to build and use, not a study.
2. Vertical domain apps (legal, clinical, insurance, government schemes). Rejected: outside our domain.
3. Dev-tool RAG ideas (CI triage, data discovery, audit findings, config drift). Rejected: several didn't actually need RAG, since a rule engine or graph would do.
4. RAG chatbots (troubleshooting bot, codebase onboarding, …). This led to the question of *who provides the RAG layer*.
5. **RAG as a package that any chatbot sits on.** ← chosen

**Concern raised and accepted:** Generic RAG libraries are a crowded category (LlamaIndex, LangChain, Haystack, plus managed APIs). A narrower alternative was proposed: a per-turn decision layer (answer / retrieve / clarify / abstain) benchmarked on MTRAG-UN. We chose the full package. That narrower idea now lives **inside** the package as the conversation layer (see D-004), not as the whole product.

**Consequence:** "Why not LlamaIndex?" must be answered with measured numbers (PLAN.md success criteria), not opinions.

---

## D-002: Phase order is library → server → template
_2026-09-21 · decided_

**Decision:** Build the library first and make it solid. Server mode and the template come after, as thin layers over the same core.

**Why:** Server mode and template add no RAG logic, only transport and UI. If the core is weak, they just wrap a weak core.

---

## D-003: Working name `openRag`
_2026-09-21 · decided (working name) · publish name open (O-4)_

**Decision:** Use `openRag` as the project/folder name for now.

**Known collision (checked 2026-09-21):**
- `langflow-ai/openrag`: 4,589★, described as a *"comprehensive, single package Retrieval-Augmented Generation platform"*. Same concept, backed by Langflow.
- PyPI `openrag` (v0.7.1) belongs to that project. npm `openrag` and `openrag-sdk` (both registries) are also taken.
- Also: `linagora/openrag` (248★), and the Open-RAG research paper repo (147★).

**Free as of 2026-09-21** (npm + PyPI): `open-rag`, `openragjs`, `openrag-js`, `openrag-ai`.

**Alternatives checked and free on npm + PyPI:** AnyRAG, PureRAG, CoreRAG, FreeRAG, JustRAG, useRAG, raglayer, ragkeel, ragroot, ragatlas, ragnite.

**Must revisit before first publish.** Publishing into another project's namespace means confused users and poor search visibility.

---

## D-004: Conversation features live in the package's conversation layer
_2026-09-21 · decided_

**Decision:** The multi-turn problems identified during research are features of the conversation layer, turned on by default:
1. Follow-up query rewriting
2. Retrieve-or-not
3. Context eviction on topic switch
4. Clarifying questions for underspecified input
5. Multi-turn citation tracking
6. Abstain when the corpus doesn't have the answer

**Why:** These are what separate a chat-native RAG package from "retrieval with a chat UI bolted on". They are also where MTRAG-UN shows current systems still fail.

---

## D-005: TypeScript-first
_2026-09-21 · decided_

**Decision:** openRag is written in TypeScript and published to npm first.

**Why:**
1. The target user is someone building a chatbot, and that's mostly web devs (Next.js/React). A Python library would force them to stand up a separate backend.
2. The Python RAG space is crowded (LlamaIndex, LangChain, Haystack, txtai). The TS options (LlamaIndex.TS, LangChain.js) are ports of those Python libraries and lag behind them.
3. All three phases (library, Node server, `npx create-…` template) stay in one language and one toolchain.
4. Token streaming, SSE and React hooks are first-class in TS, and they're core to a chatbot-native package.

**Cost accepted:** Local embeddings and rerankers are weaker in TS than in Python. Handled in the design (A-1): provider-agnostic embedder interface, with a local option and a measured install size before committing to a default.

**When we'd revisit:** if the project is pitched mainly for pure AI/ML-engineer roles, where Python signals more and local-model experiments are cheaper.

**Revisited 2026-09-22: kept.** The research is in RESEARCH.md → "TypeScript vs Python for RAG", including a live TS-only hybrid-search run. TS has everything v1 needs, because the heavy engines (SQLite, sqlite-vec, ONNX Runtime, LanceDB) are the same C/Rust code under both languages. Python is ahead on PDF parsing, eval tooling, the LlamaIndex baseline, and ML training. None of those ship in the v1 package.
- **Python is allowed** in `eval/` (Ragas/DeepEval, and the Python LlamaIndex baseline, since LlamaIndex.TS has no `CondensePlusContextChatEngine`) and in the service behind a future PDF add-on (e.g. Docling). The shipped package stays TypeScript.
- **Cost found:** the local-embedding stack installs at 531 MB (ONNX Runtime ships every platform's binaries). This feeds A-1.

---

## D-006: openRag is layer 1 of a wider chatbot framework
_2026-09-22 · decided · amends D-002_

**Context:** The long-term goal is a chatbot framework that companies integrate into their websites and that adapts to each company (see `VISION.md`). Not every company needs RAG. The framework picks the retrieval approach per data source: SQL, APIs, keyword search or RAG.

**Decision:** Build bottom-up. openRag is the first layer: the reusable RAG tool the framework calls when a question needs knowledge from documents. It stays a standalone package that's useful on its own.

**What changes in openRag's Phase 1 design:**
1. **`retrieve()`** becomes a public primitive that makes no LLM call. It returns ranked chunks, citations and a grounding signal. (M3)
2. **`asTool()`** exports a tool definition (name, description, input schema, run), so any agent loop can use openRag. (M3)
3. **Namespaces**: the `Store` interface is scoped by tenant from day one. (M2)
4. **Grounding signal**: `retrieve()` and the abstain path return `grounded` + `reason`, so a caller can fall back to another tool or escalate. (M3, M5)
5. **Extensible trace**: the trace format leaves room for tool calls and approvals, which later become the audit log. (M6)

**Kept as is:** the planner stays inside openRag but is optional. `Bot` / `ask()` / `chat()` work standalone, and the MTRAG-UN eval still targets the conversation layer. The framework's router calls `retrieve()` directly and may later generalise the planner across tools.

**Amends D-002:** the order is now library → server → knowledge tools + router → actions + permissions → onboarding + widget + dashboard. The standalone "template" phase is folded into the widget phase.

**Cost:** about 3–4 extra days in Phase 1.

**Rejected:**
- *Top-down (build the framework first).* Too big. Nothing usable for months, and the RAG layer would get built in a hurry underneath it.
- *Keep openRag chat-only (`Bot` only).* The router would have to go through a chat API just to get chunks, would pay for an LLM call it doesn't need, and couldn't combine RAG results with SQL or API results.
- *Add namespaces later.* Retrofitting isolation into a store that already holds data means a migration and a risk of cross-company leaks.

---

## D-007: Planner is one structured LLM call, plus a small-talk shortcut (A-3)
_2026-09-22 · decided_

**Decision:** Before each chat turn, openRag makes **one structured-output LLM call** that returns:
- `action`: `ANSWER` (reply from what's already been shown), `RETRIEVE` (search the docs) or `CLARIFY` (ask the user back)
- `standaloneQuery`: the message rewritten so it makes sense on its own ("and for international?" → "refund policy for international orders")
- `topicShift`: whether the user changed the subject

A cheap rule catches obvious small talk ("hi", "thanks", "ok") and skips the call entirely. `ABSTAIN` is not a planner action: it's decided after retrieval (A-4).

**Why:**
1. A bot that always searches breaks on follow-ups ("and for international?"), rephrase requests ("make it shorter") and vague questions ("how do I cancel?" when there are three plans). These are MTRAG-UN's NONstandalone and UNderspecified cases.
2. One call instead of three means one wait instead of three, and lower cost.
3. The same shape generalises to the framework's router in Phase 3, which picks between tools instead of actions.

**Rejected:**
- *Rules only (if/else).* Free and instant, but can't understand "make it shorter" or "and for international?".
- *Three separate calls* (rewrite, retrieve-or-not, clarify). Smart, but three waits and roughly three times the planning cost.
- *Always retrieve.* Fails on the cases in reason 1.

**Cost accepted:** one extra small LLM call on every turn that isn't small talk. The planner can also be wrong, by asking back too often or skipping a search it needed. Both get measured on MTRAG-UN in M6 and tuned there. The planner is optional (D-006): `retrieve()` bypasses it.

---

## D-008: Abstain uses two gates: a score check, then the LLM (A-4)
_2026-09-22 · decided_

**Decision:** openRag decides "this isn't in the docs" in two steps:
1. **Gate 1: score check** (free, no LLM). After retrieval, if the best match scores below a cut-off, the bot abstains straight away and the LLM is never called.
2. **Gate 2: the LLM may say "not found"**, in the same call that writes the answer (no extra call). The prompt tells it to report "not found" instead of making something up when the pieces don't contain the answer.

`retrieve()` has no LLM, so it runs only gate 1 and reports the result as `grounded` + `reason` (D-006).

**Why:**
- Search always returns *something*, even when the answer isn't in the docs, and an LLM handed loosely related pieces tends to invent an answer. For a company bot, that means false promises to customers.
- Gate 1 catches the obvious cases for free and saves the LLM call.
- Gate 2 catches the tricky ones, where a piece matches on words but doesn't answer the question ("do you deliver to Dubai?" vs "we deliver across India"). It costs nothing extra because the answer call happens anyway.

**Rejected:**
- *Score check only.* Misses the tricky cases above.
- *LLM check only.* Pays for an LLM call even when retrieval found nothing at all.
- *A separate LLM "grounding check" after the answer* (post-generation fact-check). An extra call on every turn.

**Open details:**
- **Which score gates.** The fused rank score (RRF) only measures order, not how good a match is, so it can't be the gate. Gate 1 uses an absolute score: the top hit's vector similarity, or the reranker score when a reranker is on. Settled in M3.
- **The cut-off value.** Too high and the bot says "I don't know" when the answer exists. Too low and it invents answers. Calibrated in M6 on MTRAG-UN's unanswerable questions. Developers can override it.
- **Gate 2 with streaming.** The model has to signal "not found" at the very start of its reply, so the stream can stop before any words reach the user. Implementation detail for M5.

---

## D-009: Streaming is a `for await` loop in core, with AI SDK support as an add-on (A-5)
_2026-09-22 · decided_

**Decision:**
1. **Core:** `bot.chat()` returns typed events (`action`, `token`, `citation`, `done` + trace) that the developer reads with `for await`. The same object is also a web `ReadableStream`, like the AI SDK's `AsyncIterableStream`. Core has no dependency on any streaming library.
2. **`toResponse()` in core:** one line to send the events to a browser as plain Server-Sent Events.
3. **`@openrag/ai-sdk` add-on:** translates openRag events into the Vercel AI SDK's UI message stream (`token` → `text-delta`, `citation` → `source-document`, `action` → `data-action`, trace → `data-trace`). A frontend can then use the AI SDK's `useChat` (messages, status, `sendMessage`, `stop`) instead of building its own chat UI.
4. `bot.ask()` stays available for anyone who just wants the whole answer at once.

**Why:**
- `for await` is the standard modern JS pattern and the one the AI SDK, OpenAI and Anthropic SDKs already use. It supports `break` for a Stop button, normal `try/catch`, and typed events with autocomplete.
- The AI SDK is where most Next.js devs already are (`ai` 18M/wk, `@ai-sdk/react` 6M/wk, see RESEARCH.md). Speaking its format gives them a ready-made chat UI, so we don't build or maintain a React hook.
- The AI SDK is on major version 7. Keeping it in an add-on means a format change only touches the "translator", never core (A-8).

**Rejected:**
- *Callbacks* (`onToken`, `onCitation`). Hard to stop mid-answer, messy error handling.
- *Only a raw web stream.* Too low-level: the developer would have to parse events themselves.
- *AI SDK as a core dependency.* Ties core to their release cycle.
- *Our own React hook.* `useChat` already exists and is widely used.

---

## D-010: Trace is our own JSON on every reply, with OpenTelemetry as an add-on (A-6)
_2026-09-22 · decided_

**Decision:**
1. **Every reply carries a trace**: a plain JSON record of each step (planner, lexical, vector, fusion, pack, grounding, generate), with timings, counts, scores, tokens and citations. No setup needed.
2. **The format is versioned** (a `version` field) and step types are open-ended, so the framework can add `tool_call` and `approval` steps later and the trace becomes the audit log (D-006).
3. **The OpenTelemetry exporter is an add-on** (`@openrag/otel`). It sends the same steps as spans to Langfuse, Phoenix, Datadog, Grafana, or any other OTel backend.
4. **A redact option** (`trace: { redact: true }`) keeps the steps, timings and numbers but drops the question, answer and document text, for companies that must not store them.

**Why:**
- Developers need "why did the bot say that?" on day one, without standing up a collector.
- The eval (M6) scores from the trace, and cost tracking reads its token counts.
- Companies with dashboards still get them, through the add-on, without the core carrying OTel's setup.

**Rejected:**
- *OTel only.* Collector/exporter setup and span concepts are too heavy for a first bot.
- *Plain logs, no structured trace.* Can't be scored by the eval or extended into an audit log.
- *A vendor SDK (e.g. Langfuse) in core.* Locks users into one tool.

---

## D-011: v1 runs on Node only (A-7)
_2026-09-22 · decided_

**Decision:** openRag v1 targets **Node 22 or newer** (tested on 22.22.0). CI runs on Node only. Bun, Deno and edge platforms aren't supported in v1.

**Why:**
- Node is where the target developers (O-2) and their hosting (Vercel, AWS, plain servers) already are.
- One runtime means one CI matrix and one set of native-dependency problems to handle while the core is built.
- Tested 2026-09-22 (RESEARCH.md → "Runtime compatibility"):
  - Node: works.
  - Deno 2.7.6: runs the TS-only pipeline unchanged.
  - Bun 1.4.0: crashes on `better-sqlite3`, and `bun:sqlite` can't load sqlite-vec on macOS without a custom SQLite.
  - Edge: can't run a local SQLite file or a native ONNX model at all.

**Rejected for v1:**
- *Node + Bun* (the earlier suggestion). The Bun test failed.
- *Node + Deno.* It works today, but supporting it means CI and fixes for a small audience.
- *Edge.* Needs a fully remote store and embedder. That's a later option.

**Revisit after v1.** Deno is close to free. Bun depends on the store chosen in A-2. The M0 store experiment doesn't need a runtime criterion any more, but portability can serve as a tie-breaker.

---

## D-012: One core package plus add-ons (A-8)
_2026-09-22 · decided_

**Decision:** `openrag` (core) holds what every user needs:
- the public API: `Bot`, `ask()`, `chat()`, `retrieve()`, `asTool()`
- the planner, search, fusion and packer
- Markdown, HTML and text parsing
- the default store
- the JSON trace and `toResponse()`

Everything else ships as `@openrag/*` add-ons: `pgvector`, `qdrant`, `openai`, `voyage`, `cohere`, `ai-sdk` (D-009), `otel` (D-010), and later `pdf`.

**Rule for what becomes an add-on:** anything that is heavy, needed by only some users, or tied to another company's format or release cycle.

**Why:** keeps the base install small, users install only what they use, and a third-party change (e.g. an AI SDK major version) touches one small add-on instead of core.

**Rejected:**
- *One package with everything.* Every user would carry every dependency, including a ~531 MB local-model engine, and any third-party change would force a core release.
- *One package with subpath exports and optional peer dependencies.* Still one version for everything, and confusing "you must also install X" errors.

**Open:** whether the local embedder (~531 MB installed) lives in core, so Level 1 is truly zero-setup, or in an add-on, so core stays small. Decided with A-1 after the M0 experiments.

**Cost accepted:** more packages to publish and version (pnpm workspaces handle it), and sometimes two installs for a user (`openrag` + `@openrag/pgvector`).

---

## D-013: Bring your own LLM, reached through our own interface backed by the AI SDK (A-9)
_2026-09-22 · decided_

**Decision:**
1. **Bring your own key.** openRag never hosts or pays for a model. Auto-detect order:
   1. an explicit `llm` option
   2. `ANTHROPIC_API_KEY`
   3. `OPENAI_API_KEY`
   4. a local Ollama
   5. otherwise, an error that lists exactly what to set
2. **Our own small `LLM` interface in core** with two operations: stream an answer, and return a structured JSON object (for the planner, D-007). The rest of openRag talks only to this interface.
3. **The default implementation is AI SDK Core** (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`, ~13 MB), pinned to one major version. Ollama goes through its OpenAI-compatible endpoint. Whether structured output works there gets checked in M4, with the community `ollama-ai-provider-v2` as the fallback.
4. **The `llm` option accepts** either an AI SDK model (`anthropic("…")`, `openai("…")`, Google, Mistral, Bedrock, …) or a custom object implementing our interface.
5. **Two model roles:** a small, fast model for the planner and a larger one for answers. The default models are chosen after the experiments (O-5).

**Why:**
- One integration covers many providers, and streaming + structured output come ready-made. That's a lot less code than hand-written clients.
- It's smaller than the official-SDK route (~13 MB vs ~29 MB).
- The Level 2 API already uses the AI SDK's style.

**Exception to D-012's add-on rule, and why:** the AI SDK is tied to another company's release cycle (a new major every 5–8 months: v3 2024-02 → v7 2026-06), which would normally make it an add-on. But every user needs an LLM, and Level 1 can't work without one. The interface contains the damage: an AI SDK major upgrade only changes the code behind the interface. How users who pass their own AI SDK model objects stay version-compatible (peer-dependency range) gets decided in M4.

**Rejected:**
- *Hand-written HTTP clients.* Too much code to write and maintain.
- *Official SDKs per provider* (`@anthropic-ai/sdk`, `openai`). Two different APIs to wrap for streaming and structured output, only 2–3 providers, and ~29 MB.
- *AI SDK called directly throughout the codebase, with no interface.* Every major upgrade would ripple through core.
- *Hosting a model ourselves.* Out of scope (VISION: never pay for users' LLM usage).

---

## D-014: First user is the web developer on Next.js; backend developers are supported (O-2)
_2026-09-22 · decided_

**Decision:**
- Docs, README quick start and the first example (`examples/nextjs-chat`) are written for a web developer adding a chat box to a Next.js site.
- openRag runs in the Next.js route handler, and the page uses the AI SDK's `useChat` through `@openrag/ai-sdk`.
- Backend developers (Express, NestJS, Hono, …) use the same library inside their own server through `ask()`, `chat()` and `retrieve()`. They're supported, just not the first example.
- Non-JS stacks are served later by the Phase 2 server (`docker run`).

**Why:**
- Next.js puts the frontend and backend in one project, so "a chat box on my site" is the shortest possible example.
- It matches D-005 (TS for web devs), D-009 (`useChat`) and the framework's end goal (a chatbot on a company website).
- `next` has ~43M weekly downloads (checked 2026-09-22).

**Clarified:** openRag is a library with no UI, and it always runs server-side, never in the browser. API keys, files, the store and local models all live on the server. Next.js is where users put it, not what it's built with.

**Rejected:** *backend developer first.* That would mean a longer first example (a separate server plus a separate frontend) for the same library.

---

## D-015: Positioning: "the RAG layer built for chatbots" (O-3)
_2026-09-22 · decided_

**Decision:** The one-line pitch is:

> **The RAG layer built for chatbots: it handles real conversations, runs without any servers to set up, and doubles as a tool for AI agents.**

Each claim has to be backed by a measurement, not asserted (D-001):

| Claim | Proof |
|---|---|
| Handles real conversations (follow-ups, unclear questions, "not in the docs") | MTRAG-UN vs LlamaIndex (M6) |
| No servers to set up | Lines of code + setup steps vs LlamaIndex (M6). Depends on M0: whether the local embedder ships in core (A-1/D-012) |
| Doubles as a tool for agents | A working `retrieve()` + `asTool()` example (success criterion 6) |

**Not claimed:** "the only one that does X" (L-001). Mastra, LlamaIndex.TS and LangChain.js exist. We only say what we can measure.

---

## D-016: Ingestion and index defaults, from the M0 practice run (A-1, A-2)
_2026-09-22 · decided · evidence: `experiments/m0/RESULTS.md`_

Measured on 133 pages of public product docs with 51 questions (42 answerable, 9 unanswerable). hit@5 = the piece holding the answer is in the top 5.

**Decisions:**
1. **Chunking: break on the document's own headings, pack up to 256 tokens, and prepend a `page › heading` header to each piece.**
   - Best top-1 (74%) and MRR (0.81) of the five strategies tried.
   - Fixed-size chunking split one answer across two pieces; heading-aware never did.
   - Dropping the header cost 7 points of hit@5 and took Hinglish from 100% to 83%.
2. **Default store (A-2): SQLite, with sqlite-vec for vectors and FTS5 for keywords.**
   - Keyword hit@5 76% vs Orama's 43% (five Orama configurations tried).
   - Index file 4.3 MB vs 15.3 MB; vector results identical, since that's the embedder's job.
   - Orama's advantage was running anywhere, which D-011 (Node only) makes irrelevant.
3. **Default embedder (A-1): `bge-small-en-v1.5` running locally (33 MB).**
   - 88% alone, 90% with the reranker, and 1102 pieces embedded in 43 s.
   - `embeddinggemma-300m` scored higher (93%) but took 23 min for the same pieces (~32× slower) and downloads 325 MB. It becomes an opt-in "quality" option, not the default.
   - `multilingual-e5-small` was worse everywhere, including on Hinglish (75% vs 83%).

**Still open from this:** whether the local-embedding stack (531 MB, mostly ONNX Runtime) ships in core or an add-on (D-012). API embedders (OpenAI, Voyage) weren't measured and should be, since many users already hold an OpenAI key.

**Revisit when:** a real customer corpus is available, or the corpus is in Devanagari Hindi (only Roman-script Hinglish was tested), or a GPU is in play (which would change gemma's cost).

---

## D-017: Reranker is on by default, fusion weight adapts (updates A-4-era plan)
_2026-09-22 · decided · evidence: `experiments/m0/RESULTS.md` §5_

**Decision:** keep both searches. **Rerank the fused top 20 by default** with `ms-marco-MiniLM-L-6-v2` (23 MB), fusing keyword and vector at equal weight (1:1). If the user turns the reranker off, the fusion switches to vector-weighted (≈0.2:1).

**Why:**
- Plain equal-weight RRF *hurt* paraphrased questions: 87% with vector alone, 67% fused. RRF treats "keyword rank 1" as equal to "vector rank 1", so keyword noise outranks the right piece when the question shares no words with the docs.
- Down-weighting keyword repairs hit@5 (83% → 90%) but never beats vector-only on top-1, so it is close to just dropping keyword.
- The reranker is what actually helps: best pipeline was fusion 1:1 + rerank (top-1 74%, MRR 0.81 with bge-small; 81% / 0.84 with gemma). With a reranker in place the fusion weight barely matters, and a full-weight keyword list gives it a more varied candidate pool.
- Keyword search stays because exact-term questions (error codes, API terms) score 100% on keyword alone, and reranked pipelines go 93% → 100% on that category.

**Cost accepted:** ~450 ms per question (median, 20 candidates, CPU) and a 23 MB model. Reranking fewer candidates is the obvious latency knob.

**Rejected:** *reranker opt-in* (the earlier plan) — without it, the default fusion is actively worse than vector-only. *Vector-only default* — loses exact-term questions. *`bge-reranker-base`* — 283 MB and worse here (83%, and 58% on Hinglish).

**Revisit:** on a real customer corpus, and in M6 where latency is measured end to end.

---

## D-018: The abstain score gate is weak; the LLM gate carries it (refines D-008)
_2026-09-22 · decided · evidence: `experiments/m0/RESULTS.md` §4_

**Finding:** retrieval scores do not separate answerable from unanswerable questions. Answerable top scores ranged 0.56–~0.9 (median 0.71) and unanswerable 0.4–0.77 (median 0.67) with bge-small. A cut-off catching 78% of unanswerable questions also refused 43% of answerable ones. A cut-off that keeps 95% of answerable questions catches only 2 of 9 unanswerable ones. The reranker score behaves the same way.

**Why:** a similarity score measures *topic*, not whether the answer is present. "Is Plausible HIPAA compliant?" retrieves the compliance page; "Who is the CEO?" retrieves the team page. Both are on-topic and score high, and neither contains the answer.

**Decisions:**
1. **Gate 1 stays, but conservative:** tuned to keep ~95% of answerable questions, so it only catches obvious junk. It must never be the main mechanism.
2. **Gate 2 (the LLM reading the pieces) is the real gate.** Abstain quality becomes a prompt and structured-output problem, measured on MTRAG-UN in M6.
3. **`retrieve()`'s `grounded` flag is documented as a weak signal** ("probably not in the docs"), not a guarantee, since `retrieve()` has no LLM (D-006). The framework's router must treat it accordingly.
4. **No fixed default threshold across models.** Score ranges shifted between embedders (bge 0.56–0.77, gemma 0.38–0.64). Calibrate per setup in M6, and evaluate a relative signal (the gap between the top hit and the rest) as an alternative.

**Caveat:** only 9 unanswerable questions, deliberately chosen to be on-topic and hard. Off-topic questions would be easier to catch.

---

## D-019: Toolchain and repository layout (M0 scaffold)
_2026-09-24 · decided_

**Language, re-confirmed:** the shipped package is TypeScript; Python is used for tooling that is not shipped (`eval/`, and later a PDF service). This is D-005 as revisited, chosen deliberately over an all-Python project.

**Layout:**
```
packages/openrag/     core package (private until O-4 is settled)
packages/@openrag/*   add-ons, as they arrive (D-012)
examples/             sample apps, starting with a Next.js chat (D-014)
eval/                 Python benchmark harness (M6)
experiments/m0/       the practice-corpus spikes that produced D-016…D-018
```

**Tools:**

| Concern | Choice | Why |
|---|---|---|
| Workspace | pnpm workspaces | Needed for core + add-ons (D-012), and it's strict about phantom dependencies |
| Language | TypeScript 5.9, strict, plus `noUncheckedIndexedAccess` | Catches the indexing mistakes that retrieval code invites |
| Build | tsup (esbuild + dts) | One command to ESM + type declarations |
| Tests | Vitest | Fast, ESM-native, no transform config |
| Lint + format | Biome | One tool instead of ESLint + Prettier, and fast enough to run on every commit |
| CI | **none for now** | Deferred until there is code worth gating. The same four checks run locally: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` |

**Notes:**
- No TypeScript project references or `composite` builds. They fought with tsup's declaration build for no benefit at this size; each package just runs `tsc --noEmit`.
- `packages/openrag` is `"private": true` so nothing can be published by accident before O-4 (the name) is settled.
- pnpm 11 blocks dependency install scripts by default; esbuild is allowed explicitly in `pnpm-workspace.yaml`, since that's how it fetches its platform binary.

**First code in the package:** the interfaces from D-006…D-018, plus weighted RRF fusion with the measured default weights (D-017) and its tests. Everything else lands in M1 onwards.

---

## Pending

See the Open Decisions table in `PROGRESS.md`: O-2 target developer, O-3 positioning, O-4 publish name, O-5 providers, O-6 default store, O-7 open source vs SaaS, O-8 framework target customer, O-9 framework name, and A-1…A-9.
