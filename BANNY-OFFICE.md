# Banny-Office integration workspace

This repository is the public organization fork of
[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory).

- `feat/server_team` tracks the upstream default branch without private customizations.
- `codex/banny-integration` adds organization workspace metadata and a pinned child project.
- `projects/jev-moderation-engine` is a **private Git submodule**. Its source and Git history are not published in this fork. Initializing it requires access to the private repository.

```sh
git clone --branch codex/banny-integration --recurse-submodules https://github.com/Banny-Office/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory
git remote add upstream https://github.com/TencentCloud/TencentDB-Agent-Memory.git
```

Keep private customizations in the child repository. Do not replace the submodule
with a regular tracked directory or push private build candidates to this fork.
Submodule commits are pinned: update the child repository first, then explicitly
review and commit its new gitlink here.

## Updating upstream

Fetch and inspect upstream changes, fast-forward `feat/server_team`, then merge
the reviewed upstream commit into `codex/banny-integration`. Preserve the private
child gitlink. Never force-reset the integration branch to upstream.

Authorized developers can use the child's `scripts/prepare_memoryhub_upgrade.py`
to build a private three-way upgrade candidate from the recorded baseline,
private extensions, and an exact upstream commit. Follow the child's
`docs/MEMORYHUB-UPSTREAM.md` for validation and deployment gates.

Updating this fork or its submodule pointer does **not** deploy or change any
running service. Public upstream changes and private product releases remain
separately reviewable.
