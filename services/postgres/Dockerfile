FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS gosu-build
WORKDIR /build
RUN curl --fail --silent --show-error --location https://github.com/tianon/gosu/archive/refs/tags/1.19.tar.gz -o gosu.tar.gz && echo 'cd9719b775dbfedae53923c9b0dc792b66d42c51e0b36652ed6f747fbadc0164  gosu.tar.gz' | sha256sum --check && tar -xf gosu.tar.gz
WORKDIR /build/gosu-1.19
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -mod=readonly -trimpath -ldflags='-s -w' -o /out/gosu .
FROM postgres:17.11-bookworm@sha256:3645570cccdfa447589da9f57dd740faa29b30938e861289a5574b6ca6b03826
# Keep PostgreSQL 17.11; apply available Debian security package updates.
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get check
COPY --from=gosu-build /out/gosu /usr/local/bin/gosu
COPY --from=gosu-build /build/gosu-1.19/LICENSE /usr/local/share/doc/gosu/LICENSE
RUN chmod 0755 /usr/local/bin/gosu && gosu --version
