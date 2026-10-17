FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS node
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
# The services use Node built-ins only; do not ship the unused npm CLI tree.
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get install -y --no-install-recommends ca-certificates libstdc++6 && apt-get check
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/LICENSE /usr/local/share/doc/node/LICENSE
WORKDIR /app
COPY crypto.cjs broker.cjs relay.cjs viewer.cjs ./
USER 1002:1002
CMD ["node","broker.cjs"]
