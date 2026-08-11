# Issues before pull requests

Open an issue before you write code. We answer it, and once the problem and the
shape of the fix are agreed, the pull request is a short step rather than a
negotiation.

This is not paperwork. Every item below is something that has cost a real
contributor real work on this repo:

- A pull request corrected two lines that `staging` had already corrected, by
  another route, days earlier. The whole change was dead on arrival.
- A pull request reversed a decision recorded in a comment in the code, for
  good reasons the author had no way to know were already weighed.
- A pull request bundled two unrelated fixes, so the simple one waited on the
  hard one.

None of those are review problems. They are all answerable in a sentence before
any code is written.

## When an issue is required

**Required** for anything that changes behaviour:

- Application, API, or CLI behaviour, including response shapes and status codes
- Database schema or migrations
- Authentication, permissions, validation, or rate limiting
- Dependencies added, removed, or upgraded
- CI, build, deployment, or environment configuration
- Pricing, limits, plans, or anything a user is charged for
- New features and new abstractions

**Not required** - open a pull request directly:

- Typos, broken links, and formatting
- Documentation that corrects a statement to match code that already behaves
  that way
- Comment and error-message wording
- Declaring a dependency the code already imports, at the version already
  resolved

If you are unsure, open the issue. A wrong guess in that direction costs you a
day; the other direction can cost you the whole change.

## What happens to your issue

| Label | Meaning |
|---|---|
| `needs-triage` | Received, not yet read. Applied automatically. |
| `accepted` | The problem is real and the proposed approach is sound and correctly scoped. Write the pull request. |
| `needs-discussion` | Real, but the approach or the scope is not settled. Do not start yet. |
| `wontfix` / `duplicate` / `invalid` | Closed, with the reason in a comment. |

**`accepted` is the signal to start.** It is what the pull request gate checks
for. Nothing else on the issue means "go".

We aim to triage within two working days. If an issue has sat longer than that,
comment on it - that is not nagging, it is the correct response, and it is the
fastest way to get it moving.

## What makes an issue answerable

The issue forms ask for these. They exist so we can answer in one pass instead
of three.

**For a bug**, the thing that settles it is a reproduction: the exact request or
steps, what happened, what you expected, and on which environment. A stack
trace, a request id, or a failing response body is worth more than a paragraph
of description.

**For a change in behaviour**, tell us what you want to do that you currently
cannot, before telling us what to build. The problem is stable; the solution is
negotiable, and we may know a cheaper one.

**Scope it.** Name what the change touches and, explicitly, what it does not. If
you find yourself listing two things joined by "and", that is usually two
issues. See [Should this be one change](#should-this-be-one-change).

**Check it is still there.** `staging` moves quickly. Confirm the behaviour on
the current default branch before filing, and say which commit you checked.

## Should this be one change

Apply this to each seam you can see in what you are proposing:

> Can piece A ship, deploy, and be correct with piece B absent or reverted?

If yes for every pair, they are separate issues and separate pull requests, no
matter how small. If any piece is only correct in the presence of another - a
schema migration and the backfill that depends on it, an interface change and
all its callers - they are one unit, no matter how large.

Diff size is not the test. A large, genuinely coupled change is one pull
request. Two small independent fixes are two.

## Opening the pull request

Once your issue carries `accepted`:

1. **Reference the issue in the pull request title**, after the conventional
   commit type:

   ```
   fix: #1978 return 403 with a body on public /api/chains
   feat(cli): #2014 add --require-verified to execute status
   ```

   This mirrors the internal `fix: KEEP-1234 description` convention. The
   `pr-title-check` workflow already accepts this shape; a separate check
   resolves the issue number and confirms the issue carries `accepted`.

2. Fill in the pull request template. The description explains what and why -
   the diff already shows how.

3. Target `staging`.

Pull requests that need no issue (the list above) are exempt from the check
automatically when their type is `docs`, `chore`, or `style`. Anything else
without a reference is failed by CI with instructions. A maintainer can apply
`no-issue-required` to exempt a pull request the rules did not anticipate.

## Continuing an existing issue

Someone may have filed it already. Search open **and** closed issues first - a
closed one often carries the reason, and reopening that thread with new evidence
is more useful than a fresh report.

If an issue is `accepted` and unclaimed, say you are taking it before you start,
so two people do not build the same thing.

## Security

Do not open an issue for a vulnerability, and do not open a pull request that
fixes one in public. Use [GitHub Private Vulnerability
Reporting](https://github.com/KeeperHub/keeperhub/security) or the email address
in [.github/SECURITY.md](.github/SECURITY.md), which also states what is in and
out of scope.

## Related

- [CONTRIBUTING.md](CONTRIBUTING.md) - setup, workflow, testing, plugin
  development
- [docs.keeperhub.com](https://docs.keeperhub.com) - product and API reference
