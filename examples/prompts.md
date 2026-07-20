# Chorus Prompt Examples

## `/chorus review`

```text
/chorus review code-review --profile quick --base origin/main --head HEAD review security and API compatibility
```

```text
/chorus review --file ./review.yaml
```

```yaml
version: 1
workflow: code-review
profile: quick
language: zh-CN
objective:
  - security
  - api-compatibility
constraints:
  - preserve-public-api
scope:
  kind: diff
  selection: staged
committee:
  - role: architect
  - role: security
  - role: maintainability
  - role: devil
  - role: integrator
stages:
  - independent-review
  - cross-review
  - devil
  - integrate
output:
  - markdown
  - json
```

## `/chorus ask`

```text
/chorus ask Compare the reliability tradeoffs between a queue-backed worker and a cron job for nightly billing reconciliation. Return a decision matrix.
```

```text
/chorus ask Review this migration plan for failure modes and missing rollback steps.
```

## `/chorus optimize`

```text
/chorus optimize Make this bug report clear enough for a senior backend engineer to act on, preserving all original facts.
```

## `chorus_answer`

```json
{
  "prompt": "Analyze this API design from security, reliability, and developer-experience perspectives.",
  "presetName": "default"
}
```
