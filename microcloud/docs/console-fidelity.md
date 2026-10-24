# Console fidelity to the approved mock

The approved mock (boxlite repo commit `16c63234`, branch `micro-cloud-app`) is the spec for the console's
layout and copy. Every page is compared side by side at 1440×1000 against it; the pairs are in
`console-shots/pairs/now-*.png` (mock left, real right). A difference stays only if the row below says why.

| page | matches the mock | remaining difference and why |
|---|---|---|
| App list | columns, status words, failure line under the status, row actions, middle-ellipsis URL | "Recently deleted" section under the list: App delete keeps data 7 days (PRD decision 8) and needs a restore |
| Overview | screenshot hero (captured after go-live), URL, deployment card, compact services with Restart, schedules, 4 metric cards incl. signed-in users, handoff row | — |
| Deployments | filter, status chips, what changed, by, when, Roll back on hover, failure line | Status filter says Live instead of Ready: the platform's word for a serving deployment |
| Logs | toolbar, level and range chips, source chips with counts, day rule, row grid, detail panel | Renders the newest 200 lines with "Show older"; the mock had a short fixed list. Detail sources (build, access, system) sit behind a Platform menu |
| Domains | BoxLite domain row with Primary, Your domains section with Add domain | Add domain is disabled with the reason: the preview platform serves apps on tunnel origins, which cannot take a custom domain. Change subdomain is absent for the same reason |
| Auth | left rail, provider logos, users with Sign out and ⋯, blocked users struck through | — |
| Database | left rail, tables with rows and schema, Browse in a side panel | — |
| Volumes | one panel per volume: name · size · access, Browse files, where the app finds it, ids behind Details, files in a side panel | No "Make public" and no S3 keys: volumes are BoxLite Volumes mounted as folders (PRD decision), not buckets. No "All volumes" link: the standalone console has only Apps |
| Variables | one-line intro, Copy from, Import .env, Reference a secret, Add variable, Set by BoxLite | — |
| Shell | Apps in the top bar | The standalone console has no Boxes, Images, Volumes or Billing pages |

Human copy never shows TOML or CLI commands; what an agent needs is behind "Copy instructions" / "Copy prompt".
