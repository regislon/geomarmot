# Code economy

The best code is code nobody has to write, read or maintain. Before adding code, walk this ladder
and stop at the first rung that answers the need. Adapted from
[ponytail](https://github.com/dietrichgebert/ponytail) (MIT).

1. **Does it need to exist?** Is the behaviour asked for, tested and used? If not, do not build it.
2. **Is it already in the codebase?** Search `transformers/_kit/`, `app/src/core/` and the
   existing transformers. Reuse or extend rather than duplicate.
3. **Is it in the standard library or the engine?** JavaScript built-ins, DuckDB SQL functions,
   DuckDB spatial functions.
4. **Is it a platform feature?** Browser APIs (Web Workers, streams, `structuredClone`, `<dialog>`,
   `datalist`) before a library.
5. **Is it in an installed dependency?** h3-js, JSTS, zarrita, MapLibre, SheetJS. Adding a new
   dependency needs a reason in the PR.
6. **Can it be one line?** Then keep it one line.
7. **Otherwise, the smallest working solution**, with its tests.

## What code economy never removes

Validation of input, error handling that tells the user what went wrong, security checks (the SQL
guard, quoting, the privacy gate), accessibility, and the fixtures and descriptions the repository
requires. Fewer lines is never a reason to skip these.

## Review checklist (paste the answers into the PR)

- Which rung of the ladder did each new function or module stop at?
- Is there code that duplicates a helper that already exists?
- Is there a new abstraction with a single user?
- Is there a new dependency, and why was nothing installed enough?
- Which shortcuts were taken on purpose, and are they in `docs/debt.md`?

With the ponytail plugin installed, `/ponytail-review` answers most of this for the current diff.
