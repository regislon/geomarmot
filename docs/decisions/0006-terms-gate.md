# 0006 — The forbidden-terms gate uses a hashed deny-list

**Status:** accepted

The repository must not mention certain names. A plaintext deny-list in the repository would
itself mention them, and a CI secret would not reach pull requests from forks. So the list is
committed only as salted SHA-256 hashes (`scripts/forbidden-terms.sha256`); the plaintext lives in
a maintainer's gitignored `.local/forbidden-terms.txt`.

Text is normalised with NFKC, split into runs on non-alphanumerics, split again on case and
letter/digit boundaries *before* lowercasing, and every piece, every run and every concatenation
of 2 or 3 adjacent pieces is hashed. `scripts/check-terms.js` scans the tree, staged content,
commit ranges, the full history from the root, and stdin. Its behaviour is specified by
`tests/terms/terms.test.js`.
