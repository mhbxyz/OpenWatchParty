# Build stage
FROM rust:1.98-alpine@sha256:7cc1c22d77d9432f7fe012a70e6d3e555af54c2a6832700ed7d553f1769ae89f AS builder

# Build mode: "dev" (fast compile, debug) or "release" (optimized)
ARG BUILD_MODE=dev

# Install build dependencies: build-base for the aws-lc-sys C sources and static
# musl linking, mold for fast linking
RUN apk add --no-cache build-base mold

# Configure Rust to use mold linker
ENV RUSTFLAGS="-C link-arg=-fuse-ld=mold"

WORKDIR /usr/src/app

# Copy dependency files first (cached layer)
COPY Cargo.toml Cargo.lock ./

# Create dummy main.rs to build dependencies
RUN mkdir src && echo "fn main() {}" > src/main.rs

# Build dependencies only (this layer is cached unless Cargo.toml/Cargo.lock change)
RUN if [ "$BUILD_MODE" = "release" ]; then \
        cargo build --release --locked; \
    else \
        cargo build --locked; \
    fi && rm -rf src

# Copy actual source code
COPY src ./src

# Build the application (only recompiles app code, not dependencies)
RUN touch src/main.rs && \
    if [ "$BUILD_MODE" = "release" ]; then \
        cargo build --release --locked && \
        cp target/release/session-server /usr/local/bin/; \
    else \
        cargo build --locked && \
        cp target/debug/session-server /usr/local/bin/; \
    fi

# Runtime stage
FROM alpine:3.24@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# Install curl for healthcheck and ca-certificates for HTTPS
RUN apk add --no-cache ca-certificates curl && \
    # Create non-root user for security
    adduser -D -u 1000 appuser

COPY --from=builder /usr/local/bin/session-server /usr/local/bin/session-server
RUN chown appuser:appuser /usr/local/bin/session-server

# Switch to non-root user
USER appuser

EXPOSE 3000

# Graceful shutdown
STOPSIGNAL SIGTERM

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -sf http://localhost:${PORT:-3000}/health || exit 1

CMD ["session-server"]
