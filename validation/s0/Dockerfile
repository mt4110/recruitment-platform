ARG BASE
FROM ${BASE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends poppler-data=0.4.12-1
RUN mkdir -p /s0 /fixtures /broker-secret /viewer-secret && chown 2101:2101 /broker-secret && chown 2102:2102 /viewer-secret
COPY validation/s0/ /s0/
COPY validation/r0/fixtures/ /legacy-fixtures/
COPY e2e/fixtures/sheets-resume.xlsx e2e/fixtures/sheets-career-history.xlsx /fixtures/
COPY docs/demo/2026-10-16-m5/m5-invoice.pdf /fixtures/m5-invoice.pdf
RUN python /s0/fixtures.py && chmod -R a+rX /fixtures
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app HOME=/tmp
USER 2103:2103
CMD ["python","/s0/probe.py"]
