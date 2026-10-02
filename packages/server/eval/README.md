# Retrieval eval

`npm run eval:retrieval -w @resolveai/server` ingests the corpus in memory with the real embedding model and runs the
labelled queries through the retriever (top 4 results, as the agent sees them). Useful flags:

- `-- --variant NAME` (repeatable) benchmarks a configuration; `NAME` joins changes with `+`:
  `baseline`, `filler`, `calibration[:noguard]`, `ambiguity[:fraction]`, `rerank[:w=1,top=10,keep=2,ctx=1]`.
  With several variants it ends with a side-by-side table.
- `-- --failures` lists the queries that went wrong; `-- --signals` dumps the evidence behind each confidence rating
  (dev queries only, on purpose); `-- --write-baseline` records `baseline.json`.
- `npm run eval:calibrate -w @resolveai/server -- --config rerank --filler on --variant "rerank:keep=2,ctx=1"` fits the
  confidence model on **dev only**, and writes `src/retrieval/calibration.json`.

## The data and how it is kept honest

| Split | Queries | Used for |
|---|---|---|
| dev | 64 (every query of `queries.json` except each fourth) | designing, fitting, choosing settings |
| held-out | 21 (each fourth of `queries.json`) | checking only |
| fresh | 46 (`queries.fresh.json`) | checking only: written **before any change in the second round, with no retrieval run on them**, then locked |

- **Gold** labels are `alias:doc_type:section`; a parent heading also matches its sub-sections. A test checks that every
  label exists in the ingested corpus (a structural check that runs no retrieval).
- **The freeze is enforced, not promised.** `queries.lock.json` holds the SHA-256 and ids of the fresh file. Every eval run,
  every calibration run and the default test run verify it, and refuse to continue if a frozen query was edited, added or
  removed. The only way past is `--relock "reason"`, which records the reason and the previous hash in the lock file.
  `calibrate.ts` additionally refuses any training set that contains a held-out or fresh id.
- **Order of operations, second round (auditable from the files):** queries written, structurally checked, locked
  (`2026-10-01T21:19:42Z`), baselined on the unchanged code, then the changes below.
- **Honest limits.** The queries were written by the same author as the corpus, so absolute numbers are optimistic.
  The held-out set has 16 answerable queries and the fresh set 37, so one query moves a rate by 6 and 3 points; read the
  95% Wilson intervals the report prints. Your own phrasing goes in the gitignored `queries.local.json`, which is
  reported separately and never used for fitting.

## Round 1: chunking (kept: title in the keyword index; dropped: row chunks)

Baseline = whole-table chunks, keyword index on section and text only. Dev set, 49 answerable queries:

| Configuration | recall@1 | recall@3 | MRR | symptom table at rank 1 | held-out recall@1 | Kept |
|---|---|---|---|---|---|---|
| Baseline | 55.1% | 98.0% | 0.741 | 22.4% | 56.3% | |
| Every table row its own chunk | 38.8% | 91.8% | 0.656 | 42.9% | 50.0% | No: rows are short and specific, so they outrank the sections they point to |
| Product and title as a low-weight keyword column | 57.1% | 98.0% | 0.748 | 22.4% | 56.3% | Yes, marginal (one query) |
| Row chunks for two-column tables only (on top of the above) | 57.1% | 100.0% | 0.762 | 20.4% | 50.0% | No: held-out recall@1 and MRR fell, and "E03" stopped asking which product |

Row chunking stays available as `maxRowColumns` on the chunker, off by default.

## What the failures say to do next

1. **The "low" rating is unreliable on answerable queries.** 6 of the 7 queries rated low had the right section in the top 4
   (for example "how do I make a claim", "warranty length"). Perfect word coverage with a short query gives a low cosine
   against a long chunk, and the cosine floor for medium confidence then forces `low`. Calibrate the sufficiency check from
   these labels instead of by hand.
2. **Ambiguity detection is weak (50% on dev).** "my pod machine won't work", "Brew Pro blinking light" and
   "coffee machine is leaking" did not ask which product, because the rule compares one top hit per product. Aggregate
   scores per product instead.
3. **Recall@1 is only about 57%** even though recall@3 is about 98%: the right section is usually there but not first.
   A cross-encoder reranker on the top 10 is the usual fix.
4. **Specification questions** ("how big is the water tank") are the one place row chunks helped. A narrower fix, such as
   a per-section boost for spec tables, is worth trying before row chunks.

## Round 2: calibration, product-level ambiguity, cross-encoder reranking

Baseline = the retriever as it stood after round 1 (`baseline.json`). Every change was added as a switchable variant and
benchmarked alone before being combined. Point estimates, one run of the final code (`r@N` = recall@N, `FA` = answerable
queries rated low, `CW` = rated high or medium but the answering section was not returned, `Abs` = unanswerable queries
rated low, `Amb` = ambiguous queries that asked which product, latency = median per search on this laptop CPU).

**Dev** (49 answerable, 9 unanswerable, 6 ambiguous)

| Variant | r@1 | r@3 | r@4 | MRR | FA | CW | Abs | Amb | p50 |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 57.1 | 98.0 | 98.0 | 0.748 | 14.3 | 0 | 88.9 | 50.0 | 2 ms |
| filler words only | 55.1 | 98.0 | 98.0 | 0.741 | 12.2 | 0 | 88.9 | 50.0 | 2 ms |
| product ambiguity (fraction 0.75) | 57.1 | 98.0 | 98.0 | 0.748 | 14.3 | 0 | 88.9 | **83.3** | 2 ms |
| reranker (keep 2, title context) | **75.5** | 95.9 | 100 | **0.864** | 14.3 | 0 | 88.9 | 50.0 | 166 ms |
| ambiguity + reranker | 75.5 | 95.9 | 100 | 0.864 | 14.3 | 0 | 88.9 | 83.3 | 181 ms |
| + calibration, no unknown-word guard | 75.5 | 95.9 | 100 | 0.864 | 0 | 0 | 100 | 83.3 | 183 ms |
| **final: + calibration with guard** | 75.5 | 95.9 | 100 | 0.864 | 10.2 | 0 | 100 | 83.3 | 211 ms |

**Held-out** (16 answerable, 3 unanswerable, 2 ambiguous)

| Variant | r@1 | r@3 | r@4 | MRR | FA | CW | Abs | Amb | p50 |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 56.3 | 100 | 100 | 0.771 | 0 | 0 | 100 | 100 | 2 ms |
| filler words only | 56.3 | 100 | 100 | 0.771 | 6.3 | 0 | 100 | 100 | 2 ms |
| product ambiguity | 56.3 | 100 | 100 | 0.771 | 0 | 0 | 100 | 100 | 2 ms |
| reranker (keep 2, title context) | 68.8 | 93.8 | 100 | 0.818 | 0 | 0 | 100 | 100 | 190 ms |
| ambiguity + reranker | 68.8 | 93.8 | 100 | 0.818 | 0 | 0 | 100 | 100 | 185 ms |
| + calibration, no unknown-word guard | 68.8 | 93.8 | 100 | 0.818 | 0 | 0 | **66.7** | 100 | 183 ms |
| **final: + calibration with guard** | 68.8 | 93.8 | 100 | 0.818 | 6.3 | 0 | 100 | 100 | 207 ms |

**Fresh** (37 answerable, 5 unanswerable, 4 ambiguous)

| Variant | r@1 | r@3 | r@4 | MRR | FA | CW | Abs | Amb | p50 |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 48.6 | 81.1 | 91.9 | 0.662 | 32.4 | 0 | 100 | 50.0 | 2 ms |
| filler words only | 45.9 | 81.1 | 91.9 | 0.649 | 27.0 | 0 | 100 | 50.0 | 2 ms |
| product ambiguity | 48.6 | 81.1 | 91.9 | 0.662 | 32.4 | 0 | 100 | **100** | 2 ms |
| reranker (keep 2, title context) | 56.8 | 91.9 | 97.3 | 0.743 | 37.8 | 2.7 | 100 | 50.0 | 179 ms |
| ambiguity + reranker | 56.8 | 91.9 | 97.3 | 0.743 | 37.8 | 2.7 | 100 | 100 | 190 ms |
| + calibration, no unknown-word guard | 56.8 | 91.9 | 97.3 | 0.743 | 5.4 | 2.7 | 100 | 100 | 246 ms |
| **final: + calibration with guard** | **56.8** | **91.9** | **97.3** | **0.743** | **21.6** | 2.7 | 100 | 100 | 198 ms |

p95 latency of the final configuration is 221 to 359 ms; the baseline is under 3 ms. Confidence reliability of the final
configuration (share of answerable queries whose answering section was returned): high 100%, 100% and 95% on dev,
held-out and fresh (n = 42, 15, 21); medium 100% (n = 2, 0, 8). The "low" bucket still contains answerable queries
(5 of 49 dev, 8 of 37 fresh), which is the remaining false-abstain problem.

### Earlier variants that were measured and not kept

| Variant (measured earlier in the round) | Result | Why not kept |
|---|---|---|
| Calibration without a reranker, 6 features, filler off | dev FA 14.3 to 12.2; **fresh FA 32.4 to 40.5**, one confident-wrong | Worse on fresh |
| Calibration without a reranker, 8 features (adds cosine prominence and top-hit coverage), filler on | dev FA 14.3 to 8.2; **held-out FA 0 to 6.3**; fresh FA unchanged at 32.4, one confident-wrong | No gain on fresh, a loss on held-out; the model file was removed rather than shipped |
| Pure reranking (no title context, no recall floor), with ambiguity | dev r@1 73.5, MRR 0.857; **held-out r@3 and r@4 100 to 93.8, MRR 0.771 to 0.740, 1 confident-wrong**; fresh r@4 91.9 to 89.2, 3 confident-wrong | Evicted correct short sections; fixed by the two safeguards below |
| Reranker blended 50/50 with the fused rank | dev r@1 59.2 against 73.5 for pure | Most of the gain disappears |
| Reranking the top 5 or top 20 instead of 10 | dev r@1 71.4 and 73.5; latency 87 ms and 324 ms | Top 10 is the best trade |

### What each change does, and the decision

1. **Product-level ambiguity: kept, on by default.** Evidence is summed per product over the top 10 fused candidates and
   the search asks which product when the runner-up has at least 0.75 of the leader (0.5 to 0.75 was a plateau on dev, 0.8
   and above lost recall; 0.75 is the most conservative value on it). Ambiguity recall rose from 50% to 83% (dev) and from
   50% to 100% (fresh), unchanged at 100% on held-out, with no needless questions on unscoped codes and nothing else
   moving. The only remaining dev miss is "Brew Pro blinking light". The old rule is kept as `v1` and, when a reranker is
   present, now reads the fused order rather than the reranked one, because reranking had silently broken it (ambiguity
   recall fell from 50% to 17% until fixed).
2. **Cross-encoder reranking (MS MARCO MiniLM, top 10): kept, on by default, `RESOLVEAI_RERANKER=off` disables it.**
   Recall@1 +18.4, +12.5 and +8.1 points and MRR +0.116, +0.047 and +0.081 on dev, held-out and fresh. Recall@4 is held
   or improved on all three; recall@3 is one query lower on dev and held-out (98.0 to 95.9, 100 to 93.8) and four queries
   higher on fresh (81.1 to 91.9); pooled over the 102 answerable queries recall@3 goes from 94 to 96 correct. The
   mechanism of the regressions in the pure version is worth knowing: the model was trained on web passages and prefers
   long manual passages ("Making espresso", "Specifications") over the short troubleshooting sections that answer the
   query, so a correct section was evicted from the top 4. Two safeguards fix most of it and are not tuned to a query:
   the document title is sent with each passage (the context the embedder also sees), and a recall floor keeps the fused
   top 2 in the returned results. Costs: about 150 to 200 ms per search on this CPU, a second model of roughly 90 MB, and one
   confident-wrong answer on fresh.
3. **Confidence calibration: kept only for the reranker configuration, with the unknown-word guard.** A logistic model
   over eleven signals, fitted on dev only with leave-one-out validation (out-of-sample log-loss 0.112 against 0.225 for
   the best non-reranker model). It uses the cross-encoder's own score, which is what the lexical and cosine signals
   lacked. Without the guard it cut fresh false abstains from 32% to 5% but rated one of three unanswerable held-out
   queries ("the grinder is jamming") high: abstain recall 100% to 67%. The guard is v1's rule (a query word the
   documentation never uses can never be high; a mostly-unknown query drops a level), carried over because a fitted model only
   learns caution from negative examples and dev has almost none. With it, abstain recall is 100% on every split and false
   abstains fall from 14.3% to 10.2% (dev) and 32.4% to 21.6% (fresh), but rise from 0 to 6.3% on held-out (one query).
   Across all 102 answerable queries, 19 false abstains become 14. The calibration fitted without a reranker was dropped.
4. **Filler words: not kept on their own** (recall@1 and MRR dip a little, held-out false abstains rise by one); the
   calibrated model is fitted with them on, which is the only place they are used.

### Which splits informed which decision (read this before trusting the numbers)

- Dev drove every fit and every setting sweep (ambiguity fraction, reranker top and blend weight).
- The reranker's title-context and recall-floor safeguards, and the decision to keep the unknown-word guard, were
  chosen after seeing held-out and fresh results, because dev contains no eviction or confident-wrong cases for them
  to show up in. The guard in particular was prompted by the held-out query "the grinder is jamming", so that query is no longer an
  independent check of it; the fresh set is the cleaner one for the guard, though its failure list was also viewed.
  Treat the held-out and fresh numbers for these three decisions as optimistic, and re-check on new queries
  (`queries.local.json`).
- The dev set has no confident-wrong example under the reranker, so the calibration has never had to learn what a
  confident mistake looks like. The guard is a patch for that, not a cure.

### What is still wrong, and what to do next

1. **Vocabulary mismatch still causes most false abstains** ("warranty length" for the warranty term, "how big is the tank"
   for the specification, "sputters", "racket"): the guard correctly sees an unknown word and cannot tell it from an
   unsupported feature. Add synonyms for real misses, and grow the labelled set (especially failures) before refitting.
2. **Recall@3 can lose a query** when the reranker promotes a long passage over a short correct one that is not in the fused
   top 2. A tuned blend, or a reranker fine-tuned on this domain, would address it.
3. **Latency** is about 200 ms on CPU. Reranking the top 5 costs about half and gave 71.4% recall@1 on dev against 73.5%.
4. "Brew Pro blinking light" (a model name shared by two products) is still not flagged: product-level evidence cannot see
   that the user named an ambiguous model; combining it with `identify_product`'s name matching would.
