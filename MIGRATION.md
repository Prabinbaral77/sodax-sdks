# Repository migration

This repository was split from:

https://github.com/icon-project/sodax-sdks

Migrated paths:

- packages/*
- apps/demo
- apps/node
- apps/node-cjs
- apps/wallet-modal-example

History was preserved using `git filter-repo`.

Because Git history was filtered, commit SHAs in this repository differ from the original repository.
See `.migration/filter-repo-commit-map.txt` for old-to-new commit mapping.

Source cutover commit:


