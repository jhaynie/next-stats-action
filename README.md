# Next.js Stats GitHub Action

Compares stats between current `canary` branch and a PR branch for
- average memory usage
- average CPU usage
- build duration
- base page size
- total build size
- node_modules size

After generating stats, they are posted as a comment on the PR that triggered them
