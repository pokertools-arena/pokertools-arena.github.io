# pokertools-arena — agent rules

## Release workflow (required)

Every change ships in the same pass. Never commit without bumping, tagging and
pushing:

1. **Bump** `version` in `package.json` and both `version` fields in
   `package-lock.json` (patch for fixes, minor for features).
2. **Update all version-coupled files** so the suite stays green:
   - `tests/release-check.mjs` (pinned expected version)
   - `docs/diagnostics/summary.json` and `docs/diagnostics/SUMMARY.md`
   - `README.md` "Current release" line
   - `docs/releases/RELEASE_NOTES.md` (new section at the top)
3. **Test:** `npm test`.
4. **Commit.**
5. **Tag:** annotated `vX.Y.Z` tag matching the bumped version.
6. **Push:** `git push origin main` and `git push origin vX.Y.Z`.

Historical release markers (older `RELEASE_NOTES` sections, version-stamped CSS
comments such as `0.4.0 — methodology`, `docs/verification/*`) are never
rewritten — only the current release identity moves.
