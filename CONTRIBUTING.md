# Contributing to Engrams

Thanks for your interest in contributing to Engrams! This document covers the process for contributing to this project.

## Developer Certificate of Origin (DCO)

All contributions must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). This certifies that you have the right to submit the work under the project's MIT license.

Add a sign-off to your commits:

```
git commit -s -m "feat: add new feature"
```

This adds a `Signed-off-by: Your Name <your@email.com>` line to the commit message, using your git `user.name` and `user.email`.

## Getting Started

```bash
# Clone the repo
git clone https://github.com/Sunrise-Labs-Dot-AI/engrams.git
cd engrams

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test
```

## Project Structure

```
packages/
  core/         # Schema, types, confidence engine, LLM abstraction
  mcp-server/   # MCP server + CLI entry point (published to npm)
  dashboard/    # Next.js localhost dashboard
  landing/      # getengrams.com landing page
```

## Branch Conventions

- `feat/` — new features
- `fix/` — bug fixes
- `chore/` — maintenance, dependencies, tooling

## Code Standards

- TypeScript strict mode — no `any` types
- Database queries through Drizzle ORM (no raw SQL except FTS5/sqlite-vec setup)
- All timestamps as ISO 8601 strings
- All IDs as `hex(randomblob(16))`
- Tests with Vitest

## Pull Requests

- One feature or fix per PR
- Include tests for new functionality
- Ensure `pnpm test` passes before submitting
- Write a clear description of what changed and why

## Reporting Issues

Use [GitHub Issues](https://github.com/Sunrise-Labs-Dot-AI/engrams/issues) for bugs and feature requests. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
