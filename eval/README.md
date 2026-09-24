# eval

Benchmark harness. Python lives here, not in the shipped package.

Reason: the reference implementations we measure against are Python. Ragas and DeepEval
are the originals, and LlamaIndex.TS has no `CondensePlusContextChatEngine`, so a fair
baseline has to run the Python library (see `docs/RESEARCH.md`).

Planned (M6):
- MTRAG-UN runner over the conversation layer
- LlamaIndex baseline on the same corpus
- results written to `eval/results.md`, including where openRag loses
