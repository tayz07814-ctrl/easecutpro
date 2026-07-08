# Retake-Aware Cut Beta — failure fixtures

Every video where Retake β under- or over-cuts becomes a **replayable offline
fixture** here. The analyzer is pure, and each run's debug JSON already contains
the raw AssemblyAI words, so a fixture needs **no API key and no network** to
replay — it locks in the fix as data, not as a phrase-specific engine patch.

Run all fixtures:

```
npm run verify-retake-aware-fixtures    # real-video regression (this folder)
npm run verify-retake-aware             # unit-level pattern tests (synthetic)
```

Both are rules-only and deterministic (the LLM judge is never called), so
provisional/ambiguous groups are asserted as *provisional*, never as cuts.

## Adding a fixture from a real failure

1. Find the run's debug JSON in `~/.easecutpro/retakeaware/debug-*.json`
   (the toast after a run names the file).
2. Extract the raw words into `<name>.words.json`:

   ```bash
   node -e 'const d=require(process.argv[1]);require("fs").writeFileSync(process.argv[2],
     JSON.stringify({provider:d.transcription_provider,mode:"verbatim",words:d.raw_words,
     segments:[],utterances:[],raw_text:d.raw_words.map(w=>w.word).join(" "),clean_text:d.clean_text||""}))' \
     ~/.easecutpro/retakeaware/debug-XXXX.json test-fixtures/retake-aware/<name>.words.json
   ```

3. Write `<name>.expected.json` — encode the DESIRED behaviour, not the current
   output:

   ```jsonc
   {
     "description": "one line — what this video exercises",
     "patterns": ["abandoned false start", "same-prefix retake", ...],  // taxonomy, for humans
     "expectCut":  [{ "text": "snippet that must be cut", "type": "false_start" }],
     "expectKeep": ["snippet that must NOT be cut"],
     "expectPatternTypes": ["false_start", "self_correction", "failed_retake"],
     "expectProvisional": ["snippet that must stay LLM-gated, not rule-cut"],
     "maxSpanSeconds": 8   // fail if any single cut span is longer (runaway guard)
   }
   ```

   Snippets match after normalization (lowercase, punctuation/dashes stripped);
   prefer distinctive multi-word snippets. `expectCut` passes if the snippet
   falls inside some cut span's covered words; `expectKeep` passes if it falls
   inside none.

4. `npm run verify-retake-aware-fixtures` — tune the **generic** detector in
   `src/shared/retakeaware/analyze.ts` until it passes. Never hardcode the
   sentence; identify the general pattern (see taxonomy below) and extend the
   matching detector.

## Pattern taxonomy (generic detectors, not per-phrase patches)

| pattern | detector | span type |
|---|---|---|
| abandoned false start (dash tail, pause after) | `detectFalseStarts` | `false_start` |
| leading dashed orphan (`your— …`) | `detectSelfCorrections` | `self_correction` |
| in-chunk self-correction (`…got— or …`) | `detectSelfCorrections` | `self_correction` |
| stutter restart, no dash (`It's got PDRN, it's got PDRN …`) | `detectSelfCorrections` | `self_correction` |
| same-prefix retake / changed final noun (`…this scent.` → `…this perfume.`) | `findRetakeGroups` (prefix_swap) | `failed_retake` |
| progressive repeated attempt / cutoff marker | `findRetakeGroups` (similarity / dash_retake) | `failed_retake` |
| spoken retake marker (`let me say that again`) | `detectFillers` → `findRetakeGroups` (marker) | `failed_retake` |
| ambiguous pair (0.35–0.55 sim) | provisional group → LLM judge | (cut only if affirmed) |
| parallel list (`foam / oil / mud mask`) | series veto | (never cut) |

## Review-first (unchanged)

These fixtures test the ANALYZER only. In the app, spans are staged as blue
highlights for review — nothing is auto-executed and no words are hidden before
**Execute cuts**. FastCut / ProCut are never imported by the beta or this harness.
