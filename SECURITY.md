# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest npm release | Yes |
| Previous releases | No |

## Reporting a Vulnerability

If you discover a security vulnerability in Engrams, please report it responsibly.

**Email:** [hello@sunriselabs.ai](mailto:hello@sunriselabs.ai)

Include:
- Description of the vulnerability
- Steps to reproduce
- Affected component (MCP server, dashboard, core library)
- Potential impact

We will acknowledge your report within 48 hours and provide a fix timeline within 7 days.

## Scope

The following are in scope:
- `@engrams/core` — schema, confidence engine, LLM abstraction, crypto
- `engrams` (npm) — MCP server and CLI
- `@engrams/dashboard` — Next.js web dashboard
- `@engrams/landing` — getengrams.com landing page

The following are **out of scope**:
- Data stored in your local `~/.engrams/` directory — this is local-only by design and under your control
- Issues requiring physical access to the machine running Engrams
- Social engineering attacks

## Security Design

- All data is stored locally in SQLite (`~/.engrams/engrams.db`) by default
- API keys (Pro tier) are encrypted with AES-256-GCM + scrypt before storage
- Credentials file (`~/.engrams/credentials.json`) is created with mode 0600
- Embeddings are computed locally via Transformers.js — no data leaves your machine unless you configure an external LLM provider
- PII detection and scrubbing available via `memory_scrub`
