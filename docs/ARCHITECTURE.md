# Architecture

_Status: **draft, under discussion.** Nothing here is decided yet except the language (TypeScript-first, D-005)._

> **Visual version: [`../openrag-arch.html`](../openrag-arch.html).** It's more detailed than this file: the big picture (where openRag fits in the framework), diagrams for every part, the chat-turn sequence, the planner, the data model, the swappable-parts table, the open decisions A-1…A-9, and a glossary. It's written in plain language. Whenever an A-decision is locked, it gets written up here and in DECISIONS.md.

## Proposed layers

```
┌─────────────────────────────────────────────┐
│  Public API        Bot / chat() / ask()      │
├─────────────────────────────────────────────┤
│  Conversation      sessions · memory ·       │
│                    query rewrite ·           │
│                    retrieve-or-not · abstain │
├─────────────────────────────────────────────┤
│  Generation        LLM adapter · prompts ·   │
│                    citations · streaming     │
├─────────────────────────────────────────────┤
│  Retrieval         lexical · vector ·        │
│                    fusion · rerank · filters │
├─────────────────────────────────────────────┤
│  Index / Store     embedded default ·        │
│                    adapter interface         │
├─────────────────────────────────────────────┤
│  Ingestion         loaders · parsers ·       │
│                    chunkers · change detect  │
└─────────────────────────────────────────────┘
        Trace + Eval run across every layer
```

## Design principle: progressive disclosure

The API has three levels. Each level must work without the one above it.

**Level 1: zero config**
```python
bot = Bot("./docs")
bot.ask("refund policy kya hai?")
```

**Level 2: configured**
```python
bot = Bot(
    sources=["./docs", "https://docs.example.com"],
    llm="…",
    store="postgres://…",
    abstain=True,
)
reply = bot.chat(session="user-42", message="aur international orders pe?")
reply.answer, reply.citations, reply.trace
```

**Level 3: swap anything**
```python
bot = Bot(
    chunker=MyChunker(),
    retriever=Hybrid(lexical=0.3, dense=0.7),
    reranker=CrossEncoder("…"),
)
```

(Examples above are Python-flavored and predate D-005. For the TypeScript API, see the "Public API" section of `openrag-arch.html`.)

## Tool surface (D-006)

openRag is layer 1 of a wider chatbot framework (`VISION.md`), so it also has to work as a tool that a router or agent calls:

- **`retrieve(query)`**: no LLM call. Returns ranked chunks, citations and `{ grounded, reason }`.
- **`asTool()`**: a tool definition (name, description, input schema, run) for any agent loop.
- **Namespaces**: every `Store` call is scoped to a tenant.
- **Grounding signal**: abstain carries a structured reason, so a caller can try another tool or escalate.
- **Trace**: the format leaves room for tool-call and approval steps, which later become the audit log.

The planner stays inside openRag and is optional. The framework's router calls `retrieve()` directly.

## Questions for the architecture discussion

**Shape**
- [ ] Language (O-1), plus how that affects the default embedding/rerank story (local models are easy in Python and harder in TS)
- [ ] Is each layer an interface with one default implementation? Where do the extension points live?
- [x] Sync vs async API; streaming as default or opt-in → `ask()` returns the whole answer, `chat()` streams `for await` events, AI SDK add-on (D-009)

**Ingestion**
- [ ] Which formats in v1 (md, txt, html, pdf?)
- [x] Chunking strategy default → heading-aware, max 256 tokens, `page › heading` header (D-016)
- [ ] Change detection / incremental re-index: content hashing?

**Index**
- [x] Embedded default store: which one? → SQLite + sqlite-vec + FTS5 (D-016)
- [x] Where do embeddings come from by default: API or local model? → local `bge-small-en` (D-016)

**Retrieval**
- [x] Hybrid by default? → yes, keyword + vector fused at 1:1 (D-017)
- [x] Rerank by default, or opt-in? → **on** by default; fusion shifts to vector-weighted if turned off (D-017)

**Conversation**
- [ ] Session storage: in-memory default, pluggable persistence?
- [ ] Query rewrite: always, or only when history exists?
- [x] Retrieve-or-not decision: LLM call, classifier, or heuristic? → one structured LLM call + small-talk shortcut (D-007)
- [x] Abstain threshold: how is it calibrated, and who sets it? → two gates (score, then LLM), cut-off calibrated in M6, overridable (D-008)

**Trace + Eval**
- [x] Trace format: our own, or OpenTelemetry-compatible? → own versioned JSON + `@openrag/otel` add-on + redact option (D-010)
- [ ] Eval: built-in CLI over MTRAG-UN + user's own test conversations?

**Providers**
- [x] Default LLM and embedding provider; provider-agnostic from day 1? → LLM: yes, own interface + AI SDK (D-013). Embedder: A-1, after M0
