# Competitor parity inventory

The current docs-based review is [grok-bot-docs-parity.md](grok-bot-docs-parity.md) (all 22 Grok Bot documentation pages). The runtime review is [parity-review-2026-10-05.md](parity-review-2026-10-05.md). The earlier inventory is superseded; its original text is retained in `/Users/mohsin/manux/work/parity-2026-10-05/parity-inventory-before.md` for traceability.

Quansiox has **partial parity**, not complete adoption of Grok Bot, Manus Studio, and Cue.

| Area | Verified state |
| --- | --- |
| Delegated subagents | Real child execution; missing per-child model selection, persisted transcripts, resume/fork, individual controls and isolated computers |
| Browser | Real host Chromium; visible snapshot/click/fill/navigation tested after repairs; background native input and Grok panel design incomplete |
| Agent VM | Real headless Linux guest; basic shell/file tools verified after contract repairs; no live guest desktop or guest GUI input |
| Sidepanel computer | Runtime status card, with a real host browser view when active; not a VM framebuffer |
| Recording | State/artifact scaffold; no production human-action collector |
| Grok design | Measured palette and default column proportions aligned; collapse, resize, persisted geometry and full browser composition missing |
| Cloud, voice, teams, automations, memory, secrets and channels | Missing or incomplete requirements; not excluded by local-first positioning |

Use the current review's feature register, evidence references, and acceptance criteria for implementation. A similarly named API or visible component is not proof of behavioral parity.
