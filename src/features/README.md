# Features

Each subdirectory here is one self-contained feature of BOBO.

```
src/features/<feature>/
  components/   UI for this feature only
  hooks/        stateful logic
  services/     API / IO / domain logic (no UI imports)
  types/        feature-local types
  utils/        pure helpers
  index.ts      the ONLY path other code may import from
```

**Add a feature:** create the folder, add only the subfolders you need, expose the public
API via `index.ts`, wire it up in `src/app/`, and add tests under `tests/unit/<feature>/`.

**Contract:** never import another feature's internals — go through its `index.ts`, or put
shared code in `src/shared/`.

Full convention: [`docs/DEVELOPMENT.md`](../../docs/DEVELOPMENT.md).
