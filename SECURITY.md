# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest npm release | Yes |
| Previous releases | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Lodis, please report it responsibly.

**Email:** [hello@sunriselabs.ai](mailto:hello@sunriselabs.ai)

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected component (MCP server, dashboard, core library)
- Potential impact

We will acknowledge your report within 48 hours and provide a fix timeline within 7 days.

## Scope

The following are in scope:
- `@lodis/core` — schema, confidence engine, LLM abstraction, crypto
- `lodis` (npm) — MCP server and CLI
- `@lodis/dashboard` — Next.js web dashboard
- `@lodis/landing` — lodis.ai landing page

The following are **out of scope**:
- Data stored in your local `~/.lodis/` directory — this is local-only by design and under your control
- Issues requiring physical access to the machine running Lodis
- Social engineering attacks

## Security Design

- All data is stored locally in SQLite (`~/.lodis/lodis.db`) by default
- API keys (Pro tier) are encrypted with AES-256-GCM + scrypt before storage
- Credentials file (`~/.lodis/credentials.json`) is created with mode 0600
- Embeddings are computed locally via Transformers.js — no data leaves your machine unless you configure an external LLM provider
- PII detection and scrubbing available via `memory_scrub`
