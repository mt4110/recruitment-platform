FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS python-build
# CPython's bundled Expat is static. Rebuild the same Python series against the
# unmodified, hash-verified upstream Expat instead of replacing another OS's libraries.
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get install -y --no-install-recommends build-essential ca-certificates curl xz-utils cmake pkg-config libssl-dev zlib1g-dev libffi-dev libbz2-dev libreadline-dev libsqlite3-dev liblzma-dev uuid-dev libncursesw5-dev
WORKDIR /build
RUN curl --fail --silent --show-error --location https://github.com/libexpat/libexpat/releases/download/R_2_9_0/expat-2.9.0.tar.xz -o expat.tar.xz && echo '1e6371862cc31999b368c3b89b49994f0677e1bab5f1b2b85ae3741f5d803051  expat.tar.xz' | sha256sum --check && tar -xf expat.tar.xz
RUN cmake -S expat-2.9.0 -B expat-build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_INSTALL_LIBDIR=lib -DEXPAT_SHARED_LIBS=ON -DEXPAT_BUILD_DOCS=OFF -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TESTS=OFF -DEXPAT_BUILD_TOOLS=OFF && cmake --build expat-build --parallel 2 && cmake --install expat-build && ldconfig && install -D expat-2.9.0/COPYING /usr/local/share/doc/expat/COPYING
RUN curl --fail --silent --show-error --location https://www.python.org/ftp/python/3.13.16/Python-3.13.16.tar.xz -o python.tar.xz && echo 'f4b1bfb3c79b5bb11b8d228a12504163b4c0dab4d679828d8f5f26b6cb6ab35d  python.tar.xz' | sha256sum --check && tar -xf python.tar.xz
WORKDIR /build/Python-3.13.16
RUN CPPFLAGS='-I/usr/local/include' LDFLAGS='-L/usr/local/lib -Wl,-rpath,/usr/local/lib' ./configure --prefix=/usr/local --enable-shared --with-system-expat --with-ensurepip=no --disable-test-modules && make -j2
# Install the standard library without the optional pip bootstrap package/wheel.
# Build-time pip runs from the verified CPython source tree and is never installed.
RUN runtime_dirs="$(make -s --no-print-directory --eval 'm6-runtime-subdirs:;@echo $(filter-out ensurepip ensurepip/_bundled,$(LIBSUBDIRS))' m6-runtime-subdirs)" && make install LIBSUBDIRS="$runtime_dirs" && ldconfig && ln -s python3 /usr/local/bin/python && install -D LICENSE /usr/local/share/doc/python/LICENSE && python3 -c "import pyexpat,importlib.util; assert pyexpat.EXPAT_VERSION == 'expat_2.9.0'; assert importlib.util.find_spec('ensurepip') is None"
FROM python-build AS inspector
WORKDIR /app
COPY requirements.txt ./
RUN PYTHONPATH=/build/Python-3.13.16/Lib/ensurepip/_bundled/pip-26.2.1-py3-none-any.whl python3 -m pip install --disable-pip-version-check --no-cache-dir --only-binary=:all: --require-hashes -r requirements.txt
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
USER root
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get check && apt-get install -y --no-install-recommends fonts-noto-cjk poppler-utils poppler-data
# Preserve the qualified Python/Expat inspector; do not substitute the browser image's system Python.
COPY --from=inspector /usr/local /usr/local
RUN ldconfig && python3 -c "import pyexpat,pikepdf,lxml.etree,PIL,ssl; assert tuple(map(int,pyexpat.EXPAT_VERSION.split('_')[-1].split('.'))) >= (2,9,0)"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@12.2.0 --ignore-scripts && npm ci --ignore-scripts
COPY server.py validator.py xlsx_validator.py invoice.mjs sandbox.py convert.py view_xlsx.py ./
ENV PYTHONDONTWRITEBYTECODE=1 HOME=/tmp/pdf-home XDG_CONFIG_HOME=/tmp/pdf-config XDG_CACHE_HOME=/tmp/pdf-cache
USER pwuser
CMD ["python","server.py"]
