# Summary

<!-- One paragraph: what this changes and why. Short/vague titles and bodies are flagged by the
     AI-quality gate and slow reviewers. -->

## Test plan

Run the gates and paste the outcomes:
- [ ] `bun run typecheck`
- [ ] `bun test ./tests`
- [ ] `bun run check:native`
- [ ] `bun run check:ai-slop`
- [ ] `bun run build` (with `HEDDLEWORK_WITHOUT_CEF=1` if CEF is out of scope)

## Review focus / risk

- Largest behavioral risk here: …
- Does this change the harness-authority or GPUIX-patch boundary? yes/no

## Notes

_Anything a reviewer should know, or delete this section._
