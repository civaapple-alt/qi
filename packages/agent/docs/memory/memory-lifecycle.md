# Memory lifecycle

Memory is a set of attributable claims, not a transcript dump. Its lifecycle allows continuity while preserving
correction, disagreement, expiry, and forgetting.

## States

```text
candidate -> accepted -> disputed
                    \-> forgotten
```

Correction creates an explicit new claim and removes the superseded claim from active retrieval. Forgetting
changes retrieval status but does not rewrite immutable Session events.

## Layers

- Working: current-task material; never automatically long-lived.
- Episodic: attributable past events.
- Semantic: accepted facts or preferences.
- Procedural: learned ways of working.
- Relational: claims about the continuing human-Agent relationship, requiring special confirmation.

## Promotion rules

Every durable claim points to a real Session event. Sensitive or relational candidates require user confirmation;
the Agent cannot accept them on its own. Expired claims and working blocks cannot re-enter long-lived retrieval.

## Retrieval

The index filters lifecycle status and expiry before relevance ranking. Context compilation then decides whether
retrieved claims fit the current budget. Relevance does not imply truth or authority.

`tests/memory-continuity.test.mjs` covers provenance, promotion, cross-Session retrieval, correction, and forgetting.
