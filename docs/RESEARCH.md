# Research

Competitive landscape and the gaps openRag is aiming at. _Compiled 2026-09-21._

## Who already ships what

| Capability | Who ships it | Status |
|---|---|---|
| Follow-up query rewriting | LlamaIndex `CondensePlusContextChatEngine`, LangChain `create_history_aware_retriever` | Solved, commodity |
| Abstain / "I don't know" | NeMo Guardrails fact-checking rail (post-generation), Cleanlab TLM trust score | Exists |
| Dialog policy + RAG | Rasa CALM Enterprise Search Policy, NeMo Guardrails dialog rails | Exists, requires adopting a heavy framework |
| Tracing | Langfuse, LangSmith, Arize Phoenix | Solved, bolt-on |
| Multi-turn eval | DeepEval `ConversationalTestCase` + Turn* metrics, Ragas `MultiTurnSample` | Exists |
| Managed end-to-end RAG API | Vectara (Agent API, Sept 2025), Ragie ($100–500/mo tiers), AWS Bedrock KB, Azure AI Search, Google | Crowded |
| Full RAG platforms | Dify, RAGFlow, Kotaemon, Onyx, langflow-ai/openrag | Crowded |
| RAG libraries | LlamaIndex, LangChain, Haystack, R2R, Cognita, txtai | Crowded |
| TS RAG libraries | LlamaIndex.TS (last release 2025-12), LangChain.js, **Mastra** (`@mastra/rag`, active) | Exist. LlamaIndex/LangChain lag their Python versions |

Market size: enterprise RAG was $1.94B in 2025, projected $9.86B by 2030 (38.4% CAGR).

## Where the gaps are

1. **The pieces are scattered.** A dev building a good RAG chatbot today stitches together LlamaIndex (rewrite), NeMo (abstain), Langfuse (trace), and DeepEval (eval). Nobody ships them as one coherent default.
2. **LlamaIndex rewrites follow-ups, but it retrieves on every turn and never asks a clarifying question.**
3. **NeMo abstains only after generating.** That costs an extra LLM call, and you write the dialog in Colang.
4. **Rasa can clarify, but only if you adopt its whole conversational framework.**
5. **Tool-calling agents** (an LLM with a `search` tool) decide retrieve-or-not implicitly, but they don't clarify or abstain systematically.
6. **Heavy abstractions.** A common complaint about LlamaIndex/LangChain is that even the simplest use case drags in a lot of abstraction.
7. **TypeScript lags Python.** Most chatbots are built by web devs, but the best RAG tooling is Python-first.

## The benchmark: MTRAG-UN

_"A Benchmark for Open Challenges in Multi-Turn RAG Conversations"_ (arXiv 2602.23184, Feb 2026)

- 666 tasks, 2,800+ conversation turns, 6 domains, corpora included
- Four challenge categories:
  - **UNanswerable**: the answer isn't in the corpus
  - **UNderspecified**: the question is incomplete
  - **NONstandalone**: the question depends on earlier turns
  - **UNclear responses**
- Finding: *"retrieval and generation models continue to struggle"* on all four.

This is openRag's conversation-layer eval set: public, categorized, and it maps directly onto the D-004 features.

## Baselines to beat (M6)

1. LlamaIndex `CondensePlusContextChatEngine`
2. A tool-calling agent with a search tool
3. (1) + NeMo Guardrails fact-check rail

## Streaming and chat-UI libraries (TS)
_Checked 2026-09-22 against npm and the published type definitions._

| Package | Version | Weekly downloads | Relevant API |
|---|---|---|---|
| `ai` (Vercel AI SDK) | 7.0.109 | 18.1M | `streamText().fullStream` is an `AsyncIterableStream` (works with `for await` *and* as a web `ReadableStream`). `createUIMessageStream` / `createUIMessageStreamResponse` stream typed parts: `text-delta`, `source-document`, `source-url`, custom `data-*` |
| `@ai-sdk/react` | 4.0.112 | 6.0M | `useChat()`: messages, `sendMessage`, `status`, `stop` |
| `@ai-sdk/anthropic` / `@ai-sdk/openai` | 4.0.59 / 4.0.72 | 9.2M / 9.6M | Provider packages behind one LLM interface |
| `langchain` | 1.5.12 | 2.1M | — |
| `llamaindex` (TS) | 0.12.1 | 83k | — |

**Takeaways:** (1) `for await` over typed events is the same pattern the AI SDK uses, so A-5 isn't inventing anything. (2) If openRag can emit the AI SDK's UI message stream, Next.js devs get a ready-made chat UI through `useChat`. (3) The AI SDK is on major version 7, so a hard dependency in core would tie openRag to its release cycle.

Source: `npm view <pkg> version`, `https://api.npmjs.org/downloads/point/last-week/<pkg>`, and `dist/index.d.ts` in the published tarballs.

**LLM-call layer (A-9), checked 2026-09-22:**
- **AI SDK major releases:** v3 2024-02-29, v4 2024-11-18, v5 2025-07-31, v6 2025-12-22, v7 2026-06-25. That's a new major roughly every 5–8 months.
- **Unpacked sizes:**
  - AI SDK route: `ai` 7.7 MB + `@ai-sdk/anthropic` 2.3 MB + `@ai-sdk/openai` 3.3 MB ≈ 13 MB
  - Official-SDK route: `@anthropic-ai/sdk` 9.2 MB + `openai` 19.9 MB ≈ 29 MB
  - `ollama` 0.1 MB
- **Ollama:** there's no official `@ai-sdk/ollama`. The community `ollama-ai-provider-v2` is at 4.0.1 (2026-07-08). Alternatively, Ollama's OpenAI-compatible endpoint can be reached through the OpenAI provider with a custom base URL.

## TypeScript vs Python for RAG
_Checked 2026-09-22: npm and PyPI versions and weekly downloads, type definitions in the published packages, Hugging Face model files, and a live run on macOS arm64 with Node 22._

| Area | TypeScript | Python | Ahead | Impact on openRag |
|---|---|---|---|---|
| Markdown / HTML parsing | `mdast-util-from-markdown` 41M/wk, `cheerio` 20M, `turndown` 6.8M, `@mozilla/readability` 2.4M | BeautifulSoup, markdown-it-py | Tie | None |
| PDF / Word | `pdfjs-dist` 19.7M (plain text), `unpdf` 2.7M, `mammoth` (docx) 6.1M | PyMuPDF 19.9M, markitdown 3.6M, Docling / unstructured (layout, tables, OCR) | **Python** | PDF is already an add-on, not v1. Later: call Docling as a service |
| Chunking | `@langchain/textsplitters` 1.2M (Markdown, Recursive, Token), `@mastra/rag` 112k (8 strategies incl. markdown, semantic-markdown), `@chonkiejs/core` 25k (v0.0.11) | `langchain-text-splitters` 9.0M, chonkie 301k | Python has more options | Low. Heading-aware chunking is plain text logic (~20 lines in the proof) |
| Token counting | `js-tiktoken` 5.8M, `gpt-tokenizer` 1.3M | tiktoken | Tie | None |
| Embeddings through an API | `openai` 28M, `cohere-ai` 364k, `voyageai` 179k | same vendors | Tie | None |
| Local embeddings | `@huggingface/transformers` 2.2M + `onnxruntime-node` 3.7M. ONNX builds exist for bge-small-en-v1.5, multilingual-e5-small, embeddinggemma-300m | sentence-transformers 5.2M (PyTorch), fastembed 1.1M | Python for GPUs, fine-tuning and model choice. Tie for running small models | **Install weight** (below) → A-1 |
| Reranking | transformers.js cross-encoders (bge-reranker-base, ms-marco-MiniLM, mxbai-rerank-xsmall have ONNX builds), `cohere-ai`, AI SDK v7 `rerank()` | sentence-transformers CrossEncoder, FlagEmbedding | Python (more models) | Low |
| Vector + keyword store | `sqlite-vec` 1.3M (mac/linux/windows binaries), `better-sqlite3` 7.5M (FTS5/BM25), `@lancedb/lancedb` 1.2M, `@orama/orama` 860k, `pgvector` 370k, Qdrant 602k, Chroma 211k | same engines (lancedb 1.75M, faiss-cpu 2.9M) | Tie. The engines are C/Rust underneath | None |
| LLM calls + structured output | `@anthropic-ai/sdk` 28M, `openai` 28M, `ai` 18M, `zod` 214M | same official SDKs | Tie | None |
| Streaming + chat UI | AI SDK `useChat` (`@ai-sdk/react` 6.0M) | needs a separate JS frontend anyway | **TypeScript** | Core reason for D-005 |
| Evaluation | `autoevals` 431k (Faithfulness, ContextRecall, ContextPrecision, ContextRelevancy, AnswerRelevancy, AnswerCorrectness), `promptfoo` 524k, `evalite` 210k | Ragas 237k, DeepEval 590k (the originals, more metrics) | **Python** | eval/ can be Python. It isn't shipped to users |
| LlamaIndex (M6 baseline) | `llamaindex` TS 0.12.1: last release 2025-12-02, 83k/wk. Has `CondenseQuestionChatEngine` and `ContextChatEngine` but **no `CondensePlusContextChatEngine`** | `llama-index-core` 0.14.25, released 2026-09-21 | **Python** | The baseline has to run in Python |
| Tracing | `@opentelemetry/api` 59M, `langfuse` 1.3M | same | Tie | None |
| ML research (training, clustering, numpy) | weak | far ahead | **Python** | Not needed in v1 |
| Small utilities | `chokidar` (file watching) 161M, `franc` (language detection) 210k, `node:crypto` (hashing, built in), `Intl.Segmenter` (sentence splitting, built in) | equivalents | Tie | None |

**Install weight (measured):** `@huggingface/transformers` + `better-sqlite3` + `sqlite-vec` + `js-tiktoken` + `mdast-util-from-markdown` = **531 MB** of node_modules.
- `onnxruntime-node` is 287 MB because it ships Windows (133 MB), macOS (85 MB) and Linux (68 MB) binaries together, and only one platform's gets used.
- transformers.js also pulls in `onnxruntime-web` (135 MB), which Node doesn't need.
- Models are downloaded separately: bge-small q8 + ms-marco-MiniLM q8 = 56 MB.
- For comparison, the PyTorch wheel alone is 127 MB compressed on macOS arm64 and 555 MB compressed on Linux x86_64 (torch 2.14.0).

This feeds A-1: the local embedder may have to be an add-on, or the install trimmed.

**Live proof (TypeScript only, on this Mac):** a 7-piece Markdown doc went through every step:
- heading-aware chunking with mdast, and token counting with js-tiktoken
- embeddings with `Xenova/bge-small-en-v1.5` q8: 7 pieces in 23 ms, 384 numbers each
- one in-memory SQLite database holding both sqlite-vec v0.1.9 and FTS5
- hybrid search with RRF fusion, then a `Xenova/ms-marco-MiniLM-L-6-v2` cross-encoder rerank: ~18 ms per query after models are loaded

Results:
- *"Can I get my money back if I live abroad?"* shares no key words with the right section. Keyword search picked the wrong section, meaning search picked the right one (Refunds › International orders), and the reranker kept it on top.
- *"what does E4012 mean"* was found by both searches (Errors › Payment errors).

This is only a toy-scale run. Speed at real scale is an M0 question.

**Competitor note (L-001):** `@mastra/rag` (TS agent framework with a RAG package) is active: v2.6.3 released 2026-09-19, 112k/wk. It belongs in the landscape table above. LlamaIndex.TS, by contrast, looks like it's slowing down.

## Runtime compatibility (A-7)
_Tested 2026-09-22 on macOS arm64. Same TS-only proof script as above: mdast + js-tiktoken + transformers.js + better-sqlite3/sqlite-vec/FTS5 + a cross-encoder._

| Runtime | Result |
|---|---|
| **Node 22.22.0** | ✅ Full pipeline works |
| **Deno 2.7.6** (`deno run -A`, npm packages, no code changes) | ✅ Full pipeline works, same results |
| **Bun 1.4.0** | ⚠️ `better-sqlite3` 13.0.3 **crashes Bun** at import (`panic: NAPI FATAL ERROR: Error::New napi_get_last_error_info`). Bun's own `bun:sqlite` has FTS5, but on macOS it can't load sqlite-vec ("This build of sqlite3 does not support dynamic extension loading"). It works after `Database.setCustomSQLite()` points at Homebrew's SQLite. `onnxruntime-node` and transformers.js embeddings work in Bun |
| **Edge** (Cloudflare Workers, Vercel Edge) | Not tested. No native add-ons and no persistent files there, so a local SQLite file and a local ONNX model can't run. It would need remote parts: Postgres/pgvector over HTTP and an API embedder |

**Takeaway:** runtime support depends on the store choice (A-2). The M0 store experiment has to include "does it run in Node, Deno and Bun" as a criterion.

## Sources

- LlamaIndex chat engines: https://developers.llamaindex.ai/python/framework/module_guides/deploying/chat_engines/usage_pattern/
- LlamaIndex Context engine: https://developers.llamaindex.ai/python/framework-api-reference/chat_engines/context/
- Rasa Enterprise Search Policy: https://rasa.com/docs/reference/config/policies/enterprise-search-policy/
- NeMo Guardrails: https://github.com/NVIDIA-NeMo/Guardrails
- Cleanlab TLM: https://help.cleanlab.ai/tlm/
- DeepEval multi-turn: https://deepeval.com/guides/guides-multi-turn-evaluation
- Ragas multi-turn: https://docs.ragas.io/en/stable/howtos/applications/evaluating_multi_turn_conversations/
- MTRAG-UN: https://arxiv.org/abs/2602.23184
- RAG-as-a-Service 2026 comparison: https://forage.ai/blog/rag-as-a-service-platforms/
- Enterprise RAG platforms 2026: https://onyx.app/insights/enterprise-rag-platforms-2026
- Ragie: https://www.ragie.ai/
- Top RAG frameworks by stars (Jan 2026): https://florinelchis.medium.com/top-10-rag-frameworks-on-github-by-stars-january-2026-e6edff1e0d91
- langflow-ai/openrag: https://github.com/langflow-ai/openrag
