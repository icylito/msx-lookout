# The update button — behaviour and logic

One control, bottom of every page: `UPDATE PRICES & COMPANIES`. It runs two jobs in sequence — prices for all listed stocks, then company/sector records — and reports progress in real time on the button itself. No modal, no spinner overlay; the button *is* the progress indicator and the rest of the app stays usable while it runs.

## State

```
phase:        "idle" | "prices" | "companies" | "done" | "failed"
done:         stocks priced so far
total:        stocks to price          (e.g. 128)
companyDone:  company records refreshed so far
companyTotal: company records to refresh (e.g. 14)
priceStatus:  "ok" | "busy" | "fail"   → header light 1
compStatus:   "ok" | "busy" | "fail"   → header light 2
priceStamp:   last successful price run  ("25 AUG 18:35")
compStamp:    last successful company run
```

`running = phase === "prices" || phase === "companies"`.

## What the button says in each phase

| phase | label | sub-line (caps, muted) | colour | click |
| --- | --- | --- | --- | --- |
| idle | `UPDATE PRICES & COMPANIES` | `LAST RUN 25 AUG 18:35 · 128 STOCKS` | clay | starts the run |
| prices | `UPDATING PRICES 46/128` | `KEEP BROWSING — THIS RUNS IN THE BACKGROUND` | clay | disabled |
| companies | `UPDATING COMPANIES 6/14` | `PRICES DONE 25 AUG 18:36` | clay | disabled |
| done | `UP TO DATE` | `FINISHED 25 AUG 18:36` | green | disabled |
| failed | `RETRY UPDATE` | `FAILED AT 46/128 — MSX DID NOT RESPOND` | red | retries from scratch |

The counter must update **per item**, not per batch — the point is that the user sees it counting. Every tick that changes `done` or `companyDone` re-renders the label.

## The progress rule

Beside the button, while `running`, a 1px hairline fills left to right:

```
overall = phase === "companies"
  ? 75 + round(companyDone / companyTotal * 25)
  : round(done / total * 100) * 0.75
```

Prices own the first 75% of the bar, companies the last 25% — so the bar never resets or jumps backwards when the run moves from one job to the other. Width transitions with `width .3s linear`.

## Sequence

1. **Start** — `phase: "prices"`, `done: 0`, `companyDone: 0`, `priceStatus: "busy"`, `compStatus: "busy"`. Both header lights start pulsing immediately, so the user sees the run from anywhere in the app.
2. **Prices** — fetch each stock's latest close; increment `done` after each one. When `done === total`: stamp `priceStamp` with the finish time, set `priceStatus: "ok"` (its light stops pulsing and goes green **before** the companies job starts — the two jobs report independently), move to `phase: "companies"`.
3. **Companies** — refresh each company/sector record; increment `companyDone` after each one. When `companyDone === companyTotal`: stamp `compStamp`, `compStatus: "ok"`, `phase: "done"`.
4. **Settle** — after ~3.6s in `done`, return to `idle` with the new stamps in the sub-line. The green `UP TO DATE` is a receipt, not a permanent state.

## Failure

Any request that fails, times out, or is cancelled stops the run where it stands: `phase: "failed"`, keep `done` at the count reached, set the affected job's status to `"fail"` (red light, not pulsing). The sub-line names the failure point and the reason. The button becomes `RETRY UPDATE` and is clickable again. Stamps are **not** advanced on failure — the header keeps showing the last time data actually landed.

Partial success is honest: if prices completed and companies failed, `priceStamp` advances and its light is green while the company light is red.

## Rules that matter

- The run is non-blocking. The user can switch pages, open a stock, sort Browse, open Settings — nothing is disabled except the button itself.
- Only one run at a time. While `running`, the click handler is a no-op and the cursor is `default`.
- The header lights are the only other indicator: **green** = current, **red** = failed, **pulsing** = updating. No text badge, no toast, no banner duplicates them.
- Counts come from the real work queue, not an estimate — `total` is the number of stocks actually being fetched in this run.
- Timestamps are written only when a job finishes successfully, and shown as `DD MMM HH:MM`.
- Cancelling (closing the app mid-run) leaves the last good stamps in place; on next launch the button reads `idle` with those stamps.

## Prototype note

The prototype fakes the two jobs with an interval and a `demoSpeed` prop, and a `SIMULATE FAILURE` link exists only to show the failed state. Both come out in the real build — replace the interval with progress events from the actual fetch loop.
