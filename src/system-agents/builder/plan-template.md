# Builder Plan (PR body template)

This markdown becomes the **body of the draft PR** Builder opens at job start. Builder updates the PR body via `gh pr edit --body` as the job progresses; the PR is the state store, not any file in the repo.

**Job ID:** <!-- filled in by Builder at job start -->
**Dispatching agent:** <!-- e.g., winston -->
**Operator:** <!-- senderEmail -->

## Goal

<!-- One or two sentences restating what the operator asked for, in Builder's own words. If the request is ambiguous, name the ambiguity here and resolve it via `question_pending` before proceeding. -->

## Scope assertion

I will modify **only** files under `<agent-path>/`. Files I will touch:

- <!-- relative path within agent-path -->

Out-of-scope changes this request would have required (if any), and why I am refusing to make them via this job:

- <!-- e.g., "would require sharedTools change — operator must file a separate coordinated PR" -->

## Plan

<!-- Ordered list of steps. Each step is something a future me (on resume) could follow without re-reading the operator's request. Note which file(s) each step touches and the rationale (which slot in the what-goes-where taxonomy applies). -->

1.
2.
3.

## Open questions

<!-- Anything I'd want to ask the operator before completing. If non-empty, I am about to emit `question_pending`. -->

## Current step

<!-- The step number I am working on right now. Updated each time I commit. On resume, I start here. -->

## Decisions log

<!-- Decisions I made along the way, with one-line rationale each. This is what shows up in the PR description so the operator and reviewers can see the "why". -->

-
