---
title: "Contributing Guide"
---

<span id="contributing-guide" class="legacy-anchor"></span>

Thank you for your interest in contributing to OpenWatchParty!

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR-USERNAME/OpenWatchParty.git
   cd OpenWatchParty
   ```
3. **Set up development environment**:
   ```bash
   just setup   # Install client dependencies and configure Git hooks
   just up
   ```
4. **Create a branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Code Style

### Rust

Follow the [Rust Style Guide](https://doc.rust-lang.org/1.0.0/style/README.html):

- Use `rustfmt` for formatting
- Use `clippy` for linting
- Prefer descriptive variable names
- Document public functions

```bash
just fmt
just lint server
```

### C#

Follow [C# Coding Conventions](https://docs.microsoft.com/en-us/dotnet/csharp/fundamentals/coding-style/coding-conventions):

- Use PascalCase for public members
- Use camelCase for private members
- Prefix interfaces with `I`
- Document public APIs with XML comments

```bash
# Format code
dotnet format
```

### JavaScript

- Use meaningful variable names
- Prefer `const` over `let`
- Avoid globals (use IIFE pattern)
- Comment complex logic

When adding or removing a client module, keep the loader's `load()` calls,
`client_js_files` in `infra/just/common.just` (the only copy: the just modules
that copy client files import it), and the controller's
`AllowedClientModules` in sync. The module must exist and be nonempty; duplicate
entries are rejected even in the C# set. A protocol change must update the
literal version declarations in JavaScript `state.js`, Rust `ws/constants.rs`
and the C# controller together.

Run `python3 infra/scripts/verify-client-contract.py` to check these contracts.
It also runs in `just test release` and CI, alongside its regression tests.
Any other just file that declares `client_js_files` must list the same modules.
The verifier reads the current literal declaration syntax; if that syntax
changes, update the verifier and tests too. It checks module membership, not
loader dependency ordering or wire compatibility. The existing plugin packaging
checks still validate embedded resources and the archive; protocol tests still
validate message behavior. This check does not generate or rewrite source code.

## Commit Messages

Format:
```
type: brief description

Longer description if needed.

Closes #123
```

Types:
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation
- `style:` Formatting
- `refactor:` Code restructure
- `test:` Tests
- `chore:` Build/tooling

Examples:
```
feat: add participant count to room list

fix: prevent feedback loop in HLS buffering

docs: update installation instructions
```

**Note:** Do not add AI signature or co-author lines (such as `Co-Authored-By` trailers) to commits.

## Pull Request Process

### 1. Before Submitting

- [ ] Code follows project style
- [ ] Tests pass (`just test`)
- [ ] Documentation updated
- [ ] Commit messages are clear
- [ ] Branch is up to date with main
- [ ] The [Code of Conduct](https://github.com/mhbxyz/OpenWatchParty/blob/main/CODE_OF_CONDUCT.md) has been reviewed

For staged GitHub Actions workflows, the pre-commit hook requires both
`actionlint` and `shellcheck` on PATH, or Docker to run the pinned validator
image containing both. Installing only `actionlint` skips embedded shell checks
in that tool; the hook therefore selects Docker or reports the missing tools.
This catches shell errors locally before the workflow lint job runs in CI.
On Git Bash, the hook converts the host mount with `cygpath` and disables MSYS
conversion only for that Docker call, preserving the container's `/repo` path.

### 2. Creating a PR

1. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```

2. Open PR on GitHub

3. Fill out the PR template:
   - Description of changes
   - Related issues
   - Testing performed
   - Screenshots (if UI changes)

### 3. Code Review

- Respond to feedback promptly
- Make requested changes in new commits
- Don't force-push during review
- Mark conversations resolved when addressed

### 4. Merging

- Maintainer will merge when approved
- Squash merge for clean history
- Delete branch after merge

## What to Contribute

### Good First Issues

Look for issues labeled `good first issue`:
- Documentation improvements
- Bug fixes with clear reproduction steps
- Small feature additions

### Needed Contributions

| Area | Examples |
|------|----------|
| Documentation | Guides, examples, translations |
| Testing | Unit tests, integration tests |
| UI/UX | Accessibility, responsiveness |
| Security | Audit, hardening |
| Performance | Optimization, profiling |

### Feature Ideas

Before implementing:
1. Check existing issues
2. Open a feature request issue
3. Get feedback on approach
4. Then implement

## Development Guidelines

### Adding New Features

1. **Discuss first** - Open an issue for significant changes
2. **Keep it focused** - One feature per PR
3. **Document** - Update relevant docs
4. **Test** - Manual testing at minimum

### Bug Fixes

1. **Reproduce first** - Confirm the bug exists
2. **Minimal fix** - Don't refactor unrelated code
3. **Test the fix** - Verify it works
4. **Add regression test** - If applicable

### Documentation

- Keep docs in sync with code
- Use clear, simple language
- Include examples where helpful
- Starlight generates each page's table of contents from its headings; update `docs/src/config/navigation.mjs` when adding a page to the site navigation.
- For links between published documentation pages, use a site-root URL such as `/product/first-watch-party/#choose-a-setup-path`. The Astro Markdown pipeline adds the configured deployment base while preserving heading fragments. Keep source-relative links in repository-only README files.
- Build the site and check rendered links and image paths, not just Markdown source targets. Capture illustrations from the actual supported UI, record the component versions, and exclude credentials.

## Testing

### Manual Testing Checklist

Before submitting, cover the behavior changed by the contribution:
- [ ] Create room works
- [ ] Join room works
- [ ] Play/pause sync works
- [ ] Seek sync works
- [ ] Leave room works
- [ ] Reconnection and host recovery/transfer work when affected
- [ ] Works in Chrome
- [ ] Works in Firefox

### Automated Tests

```bash
just test server
just test plugin
just test client
just test owpctl
```

## Continuous Integration

GitHub Actions checks every pull request targeting `main` or `dev`. Run the same project-level checks locally:

```bash
just fmt      # Format Rust code
just lint     # Run linters
just test     # Run tests
just build all # Build plugin and server image
```

See [CI/CD](/development/ci/) for workflow coverage, triggers, and security scans.

## Code of Conduct

Please read the [Code of Conduct](https://github.com/mhbxyz/OpenWatchParty/blob/main/CODE_OF_CONDUCT.md) for community expectations and how to report unacceptable behavior.

## Recognition

Contributors are recognized in:
- GitHub contributors list
- Release notes (for significant contributions)
- README acknowledgments (for major features)

## Questions?

- Open a question issue for general questions
- Open an Issue for bugs or feature requests
- Check existing issues first

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

## Thank You!

Every contribution matters - from fixing typos to implementing features. Thank you for helping make OpenWatchParty better!
