# M0 practice run: Plausible docs

_Run 2026-09-22 on an Apple M2 with 8 GB RAM, CPU only, Node 22.22.0. Everything is local: no API calls, no LLM._

## Setup

- **Corpus:** Plausible Analytics docs, 133 pages (see `corpus/SOURCE.md`). Customer-support style: billing, account, privacy, setup, troubleshooting.
- **Exam** (`questions.json`, written by hand after reading the docs). 51 questions:

  | Type | Count | What it is |
  |---|---|---|
  | exact | 15 | uses the docs' own terms and numbers |
  | paraphrase | 15 | customer words that differ from the docs |
  | hinglish | 12 | code-mixed, e.g. "Password bhool gaya, reset kaise karu?" |
  | unanswerable | 9 | not in the docs |

  Each answerable question carries an evidence phrase from the docs. `validate.mjs` checks that every phrase exists.
- **Metrics:**
  - **hit@5**: the piece containing the evidence is in the top 5
  - **hit@1**: it's the top result
  - **MRR**: mean of 1/rank over the top 10

  42 answerable questions means **1 question ≈ 2.4 points**. Differences under ~7 points are about 3 questions, so treat them as noise.
- **Retrieval modes:**
  - keyword: SQLite FTS5 BM25 with porter stemming and stopwords removed
  - vector: cosine similarity
  - hybrid: RRF of the keyword and vector top 20
  - hybrid+rerank: a cross-encoder re-sorts the hybrid top 20

## 1. Chunking
_Embedder bge-small-en, store SQLite, reranker ms-marco-MiniLM._

| Chunker | Pieces | vector hit@5 | hybrid hit@5 | +rerank hit@1 | +rerank hit@5 | +rerank MRR |
|---|---|---|---|---|---|---|
| fixed 256 tokens | 604 | 81% | 83% | 67% | 90% | 0.76 |
| headings, max 128 | 1628 | 86% | 74% | 74% | 83% | 0.78 |
| **headings, max 256** | 1102 | **88%** | 83% | **74%** | **90%** | **0.81** |
| headings, max 512 | 964 | 86% | 86% | 69% | 90% | 0.77 |
| headings, max 256, no "page › heading" header | 1102 | 86% | 74% | 67% | 83% | 0.74 |

- Fixed-size cut one evidence phrase in half (E03). Heading-aware chunking never did.
- The "page › heading" header helps: +7 hit@5 with rerank, and Hinglish goes from 83% to 100%.

## 2. Embedders and rerankers
_Chunker headings-256, store SQLite._

| Embedder | Model size | Time to embed 1102 pieces | vector hit@5 | vector hit@1 | +ms-marco rerank hit@5 | +bge-reranker-base hit@5 |
|---|---|---|---|---|---|---|
| **bge-small-en-v1.5** (English) | 33 MB | **43 s** | 88% | 69% | **90%** | 83% |
| multilingual-e5-small | 129 MB | 107 s | 79% | 60% | 90% | 83% |
| embeddinggemma-300m (multilingual) | 325 MB | **1388 s (23 min)** | **93%** | **76%** | **93%** | 83% |

By question type (vector hit@5):

| Embedder | exact | paraphrase | hinglish |
|---|---|---|---|
| bge-small-en | 93% | 87% | 83% |
| multilingual-e5-small | 93% | 67% | 75% |
| embeddinggemma-300m | 100% | 80% | 100% |

- **Rerankers:** ms-marco-MiniLM (23 MB) beats bge-reranker-base (283 MB), which was especially weak on Hinglish (58% with bge-small-en).
- **Reranker latency:** reranking 20 candidates takes a median 450 ms (p90 630 ms) per question on this CPU.
- **gemma is the most accurate**, but about 32× slower to index than bge-small (~1.26 s per piece). A 10k-piece knowledge base would take hours on a laptop CPU.
- **The "multilingual" e5 model did *not* help Hinglish here.** These questions are Roman-script and full of English product words. True Hindi (Devanagari) wasn't tested.

## 3. Store: SQLite vs Orama
_Embedder bge-small-en, chunker headings-256._

| | SQLite (sqlite-vec + FTS5) | Orama (pure JS) |
|---|---|---|
| Keyword hit@5 | **76%** | 43% (best of 5 configs tried: defaults, stopwords, stemming, thresholds) |
| Vector hit@5 | 88% | 88% (identical) |
| Hybrid (RRF) hit@5 | 83% | 88%, but hit@1 is only 40% |
| Orama's built-in hybrid | — | 57% |
| Size on disk | **4.3 MB** file | 15.3 MB JSON snapshot |
| Build time | 253 ms | 184 ms |
| Median query | keyword 0.19 ms, vector 0.60 ms | keyword 0.38 ms, vector 0.66 ms |
| Runs on | Node (native add-on) | anywhere (Bun, Deno, edge, browser) |

## 4. Abstain signal ("not in the docs")
_Can a score alone tell unanswerable questions apart? (A-4, gate 1)_

| Signal | Answerable median | Unanswerable median | Safe cut-off (keeps 95% of answerable) catches |
|---|---|---|---|
| bge-small top vector score | 0.71 (min 0.56) | 0.67 (max 0.77) | 2 of 9 unanswerable (22%) |
| bge-small + ms-marco top rerank score | −0.54 | −3.26 | 3 of 9 (33%) |
| gemma top vector score | 0.59 (min 0.38) | 0.48 (max 0.64) | 3 of 9 (33%) |

The scores overlap heavily. Any cut-off that catches most unanswerable questions also refuses a third or more of the answerable ones. **A score check alone is a weak gate.** It can only be a conservative first filter, and the LLM gate (D-008 gate 2) has to do most of the work.

## 5. Fusion weight vs reranker (follow-up test)

_Chunker headings-256. "mix a:b" = weighted RRF, keyword weight a, vector weight b._

**bge-small-en**

| Pipeline | hit@1 | hit@5 | MRR |
|---|---|---|---|
| keyword only | 50% | 76% | 0.61 |
| meaning only | 69% | 88% | 0.76 |
| mix 1:1 (plain RRF) | 60% | 83% | 0.71 |
| mix 0.2:1 | 62% | 90% | 0.72 |
| mix 0.1:1 | 64% | 90% | 0.74 |
| meaning only + rerank | 71% | 90% | 0.78 |
| mix 0.1:1 + rerank | 71% | 90% | 0.78 |
| **mix 1:1 + rerank** | **74%** | **90%** | **0.81** |

**embeddinggemma-300m**

| Pipeline | hit@1 | hit@5 | MRR |
|---|---|---|---|
| meaning only | 76% | 93% | 0.83 |
| mix 1:1 (plain RRF) | 62% | 88% | 0.74 |
| mix 0.1:1 | 71% | 90% | 0.80 |
| **meaning only + rerank** | **81%** | **93%** | **0.84** |
| **mix 0.1:1 + rerank** | **81%** | **93%** | **0.84** |
| mix 1:1 + rerank | 79% | 93% | 0.83 |

- Down-weighting the keyword list repairs plain RRF's hit@5 (83% → 90% for bge-small), but it never beats meaning-only on hit@1 or MRR. Weighting keyword down to 0.1 is close to dropping it.
- **A reranker is what actually helps**, and once it's there the fusion weight barely matters (bge: 0.78 vs 0.81 MRR; gemma: 0.84 vs 0.83). With a reranker, keeping keyword at full weight is fine or better, because the candidate pool is more varied.
- Keyword search still earns its place on exact-term questions: keyword alone gets 100% there, and reranked pipelines go from 93% to 100% on exact for bge-small.

**Suggested rule:** keep both searches. Turn the reranker **on** by default and fuse at 1:1. If a user turns the reranker off, switch the fusion to vector-weighted (≈0.2:1), which is the best no-reranker setting measured here.

## 6. Re-run with the package chunker (2026-09-25)

_The chunker in `packages/openrag` counts tokens with the embedder's own tokenizer
(`Xenova/bge-small-en-v1.5`) instead of `cl100k_base`, and its budget covers the
`page › heading` header as well as the text. Same corpus, same questions, same
embedder and reranker; `diag-verify-chunker.mjs` reproduces it._

| | chunks | hit@1 | hit@5 | MRR |
|---|---|---|---|---|
| M0 heading-256 (cl100k, text-only budget) | 1102 | 74% | 90% | 0.81 |
| **package chunker** (model tokenizer, header in budget) | **1210** | **79%** | **90%** | **0.83** |

By question type for the package chunker: exact 93% / 100% / 0.96, paraphrase 60% / 73% / 0.68,
code-mixed 83% / 100% / 0.88. Missed at 5: P02, P06, P07, P15 — all paraphrases.

Why the counts differ: the model's tokenizer counts about 14% more tokens than `cl100k` on this
corpus (p95 1.42×), so pieces that only looked as if they fit are now split. Before the change,
**140 of 1102 chunks (12.7%) were over the budget they claimed to respect**; the worst was a
markdown table counted at 255 and actually 454. Now the maximum is exactly 256.

## Findings

1. **Chunking:** heading-aware, max 256 tokens, with the "page › heading" header prepended. It gave the best top-1 and MRR, and it never cut an answer in half.
2. **Store:** SQLite. Its keyword search is much better here (76% vs 43%), the file is 3.5× smaller, and vectors are identical. Orama's portability doesn't matter while v1 is Node-only (D-011).
3. **Embedder:** bge-small-en is the practical default: fast, 33 MB, 88–90%. gemma is more accurate (93%) but too slow to index on a CPU to be the default. It's a candidate opt-in "quality" option, and worth retesting on the user's real docs.
4. **Reranker on by default, fusion 1:1** (see section 5). Plain RRF hurts paraphrased questions: vector alone scored 87%, and hybrid dropped to 67%. The keyword list pulls in noise. A reranker fixes it (90%, best top-1). Vector-weighted fusion repairs hit@5 but not top-1, so the reranker earns its place (+0.45 s per question). This changes the earlier "rerank is opt-in" plan.
5. **Abstain:** a score threshold alone can't separate answerable from unanswerable questions. Keep gate 1 conservative and rely on the LLM gate.

## Caveats

- One corpus, one domain. 42 answerable and 9 unanswerable questions. Small differences are noise.
- The questions were written by hand after reading the docs, which can favour phrasing that sits close to the docs. Self-written fixtures test your own assumptions, so they deserve a second pass.
- CPU timings on a loaded 8 GB laptop are rough. Relative speed (gemma ≈ 32× slower) is more reliable than absolute seconds.
- Retrieval only. Answer quality with an LLM isn't measured here (that's M6).

## Reproduce

```
npm install
node validate.mjs
node run.mjs A                                     # chunkers
node run.mjs B heading-256                         # embedders + rerankers (EMBEDDERS=a,b to limit)
node run.mjs C bge-small-en heading-256            # stores
node run.mjs D bge-small-en heading-256 ms-marco-minilm   # abstain signal
node diag-orama.mjs                                # Orama keyword configs
node diag-rerank-latency.mjs
```
Raw numbers are in `results/phase-*.json` and `results/phase-B.log`.
