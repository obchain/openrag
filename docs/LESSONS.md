# Lessons

Things learned the hard way. Each one has what happened, and the rule it produced.

---

## L-001: Check the incumbents before claiming a gap
_2026-09-21 · ideation_

**What happened:** During ideation we claimed "no library ships a conversation policy." A search showed LlamaIndex and LangChain already do follow-up rewriting, NeMo Guardrails does abstention, Rasa does dialog policy, and DeepEval/Ragas do multi-turn eval. The claimed gap was much smaller than stated.

**Rule:** Before writing "nobody does X" anywhere (README, docs, interview pitch), search for X first and cite what exists. The real gap is usually narrower and more specific. Here, it turned out to be "the pieces exist but are scattered, and a few behaviors are missing" (see RESEARCH.md).

---

## L-002: Check the name everywhere before falling for it
_2026-09-21 · naming_

**What happened:** `openRag` was picked as the name. A check showed `langflow-ai/openrag` (4.6k★) is the same idea under the same name, and that `openrag` is taken on both npm and PyPI.

**Rule:** Check npm + PyPI + GitHub (repos *and* orgs) before committing to a name. Anything that's hard to change later (package name, import path, domain) gets decided before the first publish, not after.

---

## L-003: "Does this actually need RAG?"
_2026-09-21 · ideation_

**What happened:** Several early ideas (config drift, data lineage, duplicate issues) turned out to be solvable with a rule engine, a graph, or plain embedding search. RAG was decoration there, not the core.

**Rule:** RAG is justified when all four hold: (1) the answer lives in scattered, unstructured human text; (2) no deterministic algorithm can produce it; (3) the answer needs citations to be trusted; (4) the corpus is too big for context and changes too often to fine-tune. Apply this test to openRag's own features and examples too.
