# Code search

Use `gh search code` for finding error strings, symbols, and usage patterns across
repositories you have access to. Never use web search for GitHub code.

## Basic search

```bash
gh search code "InvalidLimitError language:ruby" --limit 25
```

## Error pattern search

```bash
gh search code "context deadline exceeded" --repo owner/repo
```

Narrow with qualifiers rather than filtering large result sets afterwards:
`--repo owner/repo`, `--owner owner`, `--language go`, `--extension ts`,
`--filename Dockerfile`.

## Link requirements

Every code reference must be a full URL, pinned to a commit or branch:

```text
✅ https://github.com/owner/repo/blob/main/app/service.rb#L123
❌ app/service.rb
```

A relative path is not a reference: the reader cannot open it, and it does not say
which repository or revision it came from.
