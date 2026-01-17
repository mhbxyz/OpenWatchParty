---
title: Contributing
parent: Development
nav_order: 2
---

# Contributing Guide

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
   make up
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
# Format code
cargo fmt

# Run linter
cargo clippy
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

**Note:** Do not add AI signature lines (`Co-Authored-By: Claude` etc.) to commits.

## Pull Request Process

### 1. Before Submitting

- [ ] Pre-commit hooks pass (`pre-commit run --all-files`)
- [ ] Code follows project style
- [ ] Tests pass (`make test`)
- [ ] Documentation updated
- [ ] Commit messages are clear
- [ ] Branch is up to date with main

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

Look for issues labeled `good-first-issue`:
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
2. Open a discussion or issue
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
- Update table of contents

## Testing

### Manual Testing Checklist

Before submitting:
- [ ] Create room works
- [ ] Join room works
- [ ] Play/pause sync works
- [ ] Seek sync works
- [ ] Leave room works
- [ ] Reconnection works
- [ ] Works in Chrome
- [ ] Works in Firefox

### Automated Tests

```bash
# Rust tests
cd server
cargo test

# C# tests
cd plugins/jellyfin
dotnet test OpenWatchParty.Tests/OpenWatchParty.Tests.csproj
```

## Continuous Integration

All pull requests are validated by GitHub Actions CI. Your PR must pass all checks before merging.

### CI Jobs

| Job | Description | Runs On |
|-----|-------------|---------|
| **Rust Tests** | `cargo fmt --check`, `cargo clippy`, `cargo test` | Every push/PR |
| **.NET Tests** | `dotnet build`, `dotnet test` | Every push/PR |
| **JavaScript Lint** | `node --check` syntax validation | Every push/PR |
| **Build Server** | Docker image build | After Rust tests pass |

### Security Scans

| Scan | Description | Frequency |
|------|-------------|-----------|
| **Cargo Audit** | Rust dependency vulnerabilities | Every push/PR + weekly |
| **Trivy** | Docker image CVE scan | Every push/PR + weekly |
| **CodeQL** | JavaScript static analysis | Every push/PR + weekly |

### Fixing CI Failures

**Rust formatting:**
```bash
cd server && cargo fmt
```

**Clippy warnings:**
```bash
cd server && cargo clippy -- -D warnings
# Fix the warnings or justify with #[allow(...)]
```

**Build failures:**
```bash
# Check locally before pushing
make build
```

### Running CI Checks Locally

```bash
# Run all pre-commit hooks (mirrors CI)
pre-commit run --all-files

# Or run individual checks
make fmt      # Format Rust code
make lint     # Run linters
make test     # Run tests
make build    # Build all components
```

## Code of Conduct

### Be Respectful

- Welcome newcomers
- Be patient with questions
- Accept constructive criticism
- Focus on what's best for the project

### Be Professional

- No harassment or discrimination
- Keep discussions on-topic
- Respect others' time

### Report Issues

If you experience or witness unacceptable behavior:
- Contact maintainers privately
- Provide specific details
- Allow time for investigation

## Recognition

Contributors are recognized in:
- GitHub contributors list
- Release notes (for significant contributions)
- README acknowledgments (for major features)

## Questions?

- Open a GitHub Discussion for general questions
- Open an Issue for bugs or feature requests
- Check existing issues and discussions first

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.

## Thank You!

Every contribution matters - from fixing typos to implementing features. Thank you for helping make OpenWatchParty better!
