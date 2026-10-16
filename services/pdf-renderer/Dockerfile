FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
USER root
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-cjk poppler-utils python3-venv
WORKDIR /app
COPY requirements.txt ./
RUN python3 -m venv /opt/pdf-venv && /opt/pdf-venv/bin/pip install --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY server.py validator.py xlsx_validator.py invoice.mjs ./
ENV PATH=/opt/pdf-venv/bin:$PATH
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp/pdf-home XDG_CONFIG_HOME=/tmp/pdf-config XDG_CACHE_HOME=/tmp/pdf-cache
USER pwuser
CMD ["/opt/pdf-venv/bin/python","server.py"]
