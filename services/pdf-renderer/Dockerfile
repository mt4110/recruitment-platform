FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS inspector
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
USER root
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get install -y --no-install-recommends fonts-noto-cjk poppler-utils
# Preserve the qualified Python/Expat inspector; do not substitute the browser image's system Python.
COPY --from=inspector /usr/local /usr/local
RUN ldconfig && python -c "import pyexpat,pikepdf,lxml.etree,PIL,ssl; assert tuple(map(int,pyexpat.EXPAT_VERSION.split('_')[-1].split('.'))) >= (2,7,2)"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@12.2.0 --ignore-scripts && npm ci --ignore-scripts
COPY server.py validator.py xlsx_validator.py invoice.mjs ./
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp/pdf-home XDG_CONFIG_HOME=/tmp/pdf-config XDG_CACHE_HOME=/tmp/pdf-cache
USER pwuser
CMD ["python","server.py"]
