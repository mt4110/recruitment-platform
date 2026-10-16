FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
WORKDIR /app
COPY crypto.cjs broker.cjs relay.cjs ./
USER 1002:1002
CMD ["node","broker.cjs"]
