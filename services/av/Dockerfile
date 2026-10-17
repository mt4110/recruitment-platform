FROM clamav/clamav:1.5.4-debian13-slim@sha256:9a96980b265cb2b51a20bdcca921dc80aa55ed0e56cdfb076198ee27a9171927
USER root
# Debian security-maintained Python standard library only; no pip dependencies.
RUN apt-get update && apt-get upgrade -y --no-remove && apt-get install -y --no-install-recommends python3 libexpat1=2.9.0-1~deb13u1 && apt-get check && mkdir -p /signatures /app && chown 1000:1000 /signatures
COPY --chown=1000:1000 *.py /app/
USER 1000:1000
WORKDIR /app
ENTRYPOINT ["python3"]
CMD ["scanner.py"]
