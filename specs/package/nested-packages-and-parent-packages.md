### Nested Packages and Parent Packages

For a workspace with nested packages:

```text
<workspace-root>/
  .openpackage/
    package.yml                 # root workspace package
    .openpackage/…              # (optional) root package universal content
    packages/
      alpha/
        package.yml
        .openpackage/…
      beta/
        package.yml
        .openpackage/…
```

- Each `packages/<name>/` directory is its **own canonical package root**, with:
  - Its own `package.yml`
  - Its own `.openpackage/…`
  - Its own root files
- The parent root package **never inlines** `packages/<name>/` into its own payload.
- Registry entries for `alpha` and `beta` are created independently from their respective package roots.


