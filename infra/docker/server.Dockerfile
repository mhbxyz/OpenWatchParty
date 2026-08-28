# Build stage
FROM rust:1.98-alpine@sha256:a10e64dd139b7387337c7fbe8aca31b959b57b2fd4c8ae20a02cf1d6ea424dce AS builder

# Build mode: "dev" (fast compile, debug) or "release" (optimized)
ARG BUILD_MODE=dev

# Install build dependencies: musl-dev for static linking, mold for fast linking
RUN apk add --no-cache musl-dev mold

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
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

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
