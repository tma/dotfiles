# Deep review

Read this when the user asks for a deep, thorough, comprehensive, or extra careful
review. For normal reviews, the primary review in `SKILL.md` is the whole job.

Run the reviewers through the `second-opinion` skill, which owns the reviewer
contract, launch mechanics, and error handling. This file owns what a deep code
review requires on top of that skill's defaults: routes, count, focus split, and
synthesis. Give `second-opinion` these requirements when you delegate.

## Before delegating

Gather the normal review context first: the full diff, the surrounding files, the
PR body, comments, and linked issues, plus the requirements you established in
step 3 of `SKILL.md`. Reviewers get one prepared packet; they should not have to
rediscover context.

An explicit deep or multi-reviewer request is honored as asked, whatever the size
of the diff. If a required route is unavailable, report which one and what ran in
its place rather than quietly reviewing alone.

## What deep review requires

- **Routes.** Include both the latest GPT and the latest Opus routes at maximum
  thinking (`xhigh`). This overrides the usual preference for a single
  non-current family: cross-family disagreement is the point of a deep review.
- **Count.** Two reviewers by default. Three when the user asks for a very
  thorough review or explicitly asks for three; the third is the latest Grok route
  at maximum thinking.
- **Same-family fallback.** Reusing a route to reach the requested count is
  allowed. Label each reviewer's route and focus so the user can see it happened.
- **Read-only.** Reviewers do not edit files, post comments, request reviews,
  change repository or PR state, or delegate further. The `second-opinion` skill
  states the full contract; do not relax it here.

## Focus split

Give each reviewer the same packet and a different focus:

1. Correctness, security, and data-loss risk.
2. Edge cases, reliability, error handling, and tests.
3. Maintainability, performance, operational risk, and design fit.

With two reviewers, use the first two and fold design fit into the second.

## Synthesis stays here

Reviewer output is advisory. This session owns the conclusion:

- Present each reviewer's findings separately, with its route and focus.
- Rerank against the diff you read: promote what the reviewers underrated,
  demote what does not hold up, and say which findings you checked.
- Mark likely false positives and say why.
- Fold reviewer findings into the requirements and quality sections of the main
  report rather than leaving two disconnected reviews.
- State the recommended next step.

Nothing gets posted to GitHub because a reviewer suggested it. Publishing follows
the rules in `SKILL.md`.
