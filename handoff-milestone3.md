# Handoff: Milestone 3 — Polish + npm Publish + Distribution

**Repo:** `Sunrise-Labs-Dot-AI/engrams`
**Branch:** `main`
**Budget:** $5
**Timeout:** 15 min
**Prerequisite:** Milestone 1 (MCP server) and Milestone 2 (dashboard) complete

## Context

Engrams has a working MCP server and web dashboard. This milestone makes it installable by anyone in the world with a single JSON snippet. The goal: `npx -y engrams` just works — no clone, no build, no config beyond the MCP snippet.

Read `CLAUDE.md` in the repo root for full product context.

## Step 1: npm Package Prep

### packages/mcp-server/package.json

Ensure these fields are correct:

```json
{
  "name": "engrams",
  "version": "0.1.0",
  "description": "Universal AI memory layer — MCP server with persistent, cross-tool memory for Claude Code, Cursor, Windsurf, and more",
  "bin": {
    "engrams": "./dist/cli.js"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": [
    "dist"
  ],
  "keywords": [
    "mcp",
    "memory",
    "ai",
    "agents",
    "claude",
    "cursor",
    "windsurf",
    "model-context-protocol",
    "sqlite",
    "local-first"
  ],
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/Sunrise-Labs-Dot-AI/engrams"
  },
  "homepage": "https://getengrams.com",
  "author": "Sunrise Labs <hello@sunrise-labs.ai>"
}
```

**Critical checks:**
- `"files"` only includes `dist` — no source, no tests, no dev config in the published package
- `bin.engrams` points to `./dist/cli.js` which must have `#!/usr/bin/env node` shebang
- `@engrams/core` must be bundled into the dist (not a peer dependency) — users install `engrams`, not the monorepo. Use `tsup` or `esbuild` to bundle core into the server build, or publish `@engrams/core` to npm as a dependency.

### Bundling Strategy

The published `engrams` package must be self-contained. Two options:

**Option A (recommended): Bundle core into mcp-server**
- Add `tsup` to mcp-server devDependencies
- Configure to bundle `@engrams/core` into the output
- Single package, no monorepo dependency resolution for end users

**Option B: Publish @engrams/core separately**
- Publish `@engrams/core` to npm
- List it as a dependency of `engrams`
- More packages to maintain but cleaner separation

Pick Option A unless there's a reason to expose core separately.

### tsup config (if using Option A)

```typescript
// packages/mcp-server/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: ["@engrams/core"],  // Bundle core into output
  banner: {
    js: "#!/usr/bin/env node",  // Only for cli.ts — handle conditionally if needed
  },
});
```

## Step 2: README Polish

Update the root `README.md` to be the npm landing page. It should include:

1. **One-line description** + badge row (npm version, license, GitHub stars)
2. **What is Engrams** — 3-4 sentences
3. **Quick Start** — the JSON config snippet (Claude Code, Cursor, Claude Desktop tabs/sections)
4. **What you get** — bullet list of the 12 MCP tools
5. **Web Dashboard** — screenshot placeholder + how to start it (`npx engrams --dashboard` or separate command)
6. **How it works** — brief architecture (SQLite + FTS5, local-first, no accounts)
7. **MCP Config Examples** — config snippets for each supported tool:
   - Claude Code (`~/.claude.json` or project config)
   - Claude Desktop (`claude_desktop_config.json`)
   - Cursor (`.cursor/mcp.json`)
   - Windsurf
   - Cline
8. **Contributing** — standard OSS section
9. **License** — MIT

Keep it scannable. A developer should go from "what is this" to "installed and working" in under 2 minutes.

## Step 3: Pre-publish Checks

```bash
# Build everything
pnpm build

# Run all tests
pnpm test

# Dry-run the publish to see what would be included
cd packages/mcp-server
npm pack --dry-run
# Verify: only dist/ files, no source, reasonable size (<1MB ideally)

# Test the bin works from the packed tarball
npm pack
npm install -g ./engrams-0.1.0.tgz
engrams --help  # or just run it and verify MCP server starts
npm uninstall -g engrams
```

## Step 4: Publish to npm

```bash
cd packages/mcp-server
npm publish --access public
```

Verify: `https://www.npmjs.com/package/engrams` shows the package.

## Step 5: Verify End-to-End

On a clean machine (or in a fresh directory with no local repo):

```json
{
  "mcpServers": {
    "engrams": {
      "command": "npx",
      "args": ["-y", "engrams"]
    }
  }
}
```

1. Add config to Claude Code
2. Start a conversation: "Remember that I prefer dark mode in all my apps"
3. Verify memory is written (`~/.engrams/engrams.db` created)
4. Search: "What do you know about my preferences?"
5. Verify memory is returned with confidence score

## Step 6: GitHub Release

```bash
gh release create v0.1.0 --title "v0.1.0 — Initial Release" --notes "$(cat <<'EOF'
## Engrams v0.1.0

First public release of Engrams — a universal, portable memory layer for AI agents.

### What's included
- MCP server with 12 tools (write, search, confirm, correct, flag, connect, permissions, and more)
- SQLite + FTS5 backend (local-first, zero-config)
- Counter-based confidence scoring with source attribution
- Web dashboard for browsing and managing memories (localhost)
- Works with Claude Code, Cursor, Windsurf, Claude Desktop, Cline

### Quick Start
```json
{
  "mcpServers": {
    "engrams": {
      "command": "npx",
      "args": ["-y", "engrams"]
    }
  }
}
```

### Links
- npm: https://www.npmjs.com/package/engrams
- Docs: https://getengrams.com
EOF
)"
```

## Verification

- [ ] `npm info engrams` returns package metadata
- [ ] `npx -y engrams` starts the MCP server (stdio transport)
- [ ] Config snippet works in Claude Code
- [ ] README renders correctly on npmjs.com and GitHub
- [ ] GitHub release exists at v0.1.0
- [ ] `~/.engrams/engrams.db` auto-creates on first run with correct permissions (0600)
