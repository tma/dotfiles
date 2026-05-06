---
name: code-search
description: Search GitHub code for error patterns and root cause context
---

# Code Search

## Basic Search

```bash
gh search code "InvalidLimitError language:ruby" --limit 25
```

## Error Pattern Search

```bash
gh search code "context deadline exceeded" --repo github/<repo>
```

## Link Requirements

**Every code reference MUST be a full URL:**
```
✅ https://github.com/owner/<repo>/blob/main/app/service.rb#L123
❌ app/service.rb (relative path FORBIDDEN)
```
