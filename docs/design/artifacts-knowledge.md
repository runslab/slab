# Design sketch: artifacts as knowledge carriers (policy, skills, docs)
_Status: idea capture, 2026-07-07. Not scheduled. Origin: "each artifact could
contain a hierarchy of skills/md files to be applied — like an organization
wants to enforce the PaaS to use x, y, z services."_

## The idea

Every slab artifact — app, system, someday the whole installation — can carry
an attached hierarchy of knowledge files that tools and agents *apply*:

```
myapp/
  slab.toml
  .slab/
    docs/architecture.md        # what this thing is (for humans AND agents)
    skills/deploy-checklist.md  # how to operate it
    policy/allowed-services.md  # what it may depend on
carehub.system.toml
carehub.system/                 # system-level knowledge, applies to all members
  policy/org-baseline.md        # e.g. "only postgres for storage, no external
                                #  LLM calls except via Cairn, images from
                                #  registry X only"
```

Three escalating uses:

1. **Docs surfaced in place** — the dashboard's flip-side board and the MCP
   (`slab_docs <app>`) serve the attached markdown. The knowledge graph the
   diagram view draws visually gets a textual layer.
2. **Skills for agents** — an agent deploying/modifying an app first reads its
   attached skills (exactly the CLAUDE.md / skills pattern, but scoped to the
   artifact and traveling with it through git).
3. **Policy enforcement** — org-level constraints evaluated at deploy time:
   allowed base images, required `postgres` instead of ad-hoc DBs, mandated
   wire targets (e.g. all LLM traffic through a Cairn gateway member),
   forbidden public exposure. Start as warnings, graduate to hard errors.

## Why it fits the thesis

- Agents create infrastructure faster than humans can review it. Attached,
  machine-readable policy is how an organization's judgment scales with them.
- This is the **slab ↔ Cairn seam made concrete**: slab enforces *deploy-time*
  policy (what may exist); Cairn enforces *runtime* policy (what may be
  called). Same policy documents could feed both.
- Inheritance mirrors the artifact hierarchy: installation → system → app,
  nearest wins, all of it in git next to the code it governs.

## Honest scoping

This is a v0.4+ feature at the earliest — jobs and guardrails come first, and
policy enforcement done badly is worse than none. The cheap first step
(surface `.slab/docs/*.md` on the board + an MCP tool) is a weekend; the
enforcement engine is not.
