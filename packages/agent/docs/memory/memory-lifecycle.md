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

Correction is one event-store batch: replacement candidate, user acceptance, and dispute of the old claim. The
Memory index applies that batch in one SQLite transaction. If event commit succeeds but projection fails, the
stable operation ID prevents a duplicate and startup replay repairs the index.

## Layers

- Working: current-task material; never automatically long-lived.
- Episodic: attributable past events.
- Semantic: accepted facts or preferences.
- Procedural: learned ways of working.
- Relational: claims about the continuing human-Agent relationship, requiring special confirmation.

## Promotion rules

Every durable claim points to a real Session event. Sensitive or relational candidates require user confirmation;
the Agent cannot accept them on its own. Expired claims and working blocks cannot re-enter long-lived retrieval.
Promotion copies an accepted Project claim into the fixed local User Continuity Session; it never rewrites the
source claim's scope. `always` is a user-only activation for accepted User claims, limited to four claims of at
most 1,000 characters.

## Scope and storage

- Session: exact Session ID, stored/indexed only in the current project.
- Project: exact project ID, shared by Sessions in that project only.
- User: `userId: "local"`, explicitly confirmed and stored in `$QI_HOME/state`.
- Legacy strings: replayable for compatibility but excluded from structured cross-domain retrieval.

Claim text is plaintext in machine-private SQLite. Credential/API-key patterns are rejected before the source or
candidate event is committed. Existing conversation history is not backfilled into claims.

## Retrieval

The index filters `validFrom`, expiry, lifecycle status, working claims, and exact scope before deterministic
Latin/CJK relevance ranking and normalized deduplication. A Run considers at most 12 claims: up to four `always`
User claims first, then relevant Session, Project, and User claims. Context compilation may omit any Memory block
and records included/omitted `memory:<id>` values. Relevance does not imply truth or authority.

`tests/memory-continuity.test.mjs` covers provenance, promotion, cross-Session retrieval, correction, and forgetting.
