FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS build
WORKDIR /build
ENV CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
# Cache fixed dependencies separately so a source edit only rebuilds the API crate.
RUN mkdir -p src && printf 'fn main() {}\n' > src/main.rs && cargo build --locked --release
COPY src ./src
RUN touch src/main.rs && cargo build --locked --release && cargo test --locked --release drafts::
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get check && apt-get install -y --no-install-recommends ca-certificates curl && mkdir -p /data/resumes && chown 1001:1001 /data/resumes
COPY --from=build /build/target/release/recruitment-api /usr/local/bin/recruitment-api
USER 1001:1001
CMD ["recruitment-api"]
