FROM nginx:1.30.6-alpine@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5
# Keep the qualified nginx release and receive security fixes from its own Alpine series.
USER root
RUN apk upgrade --no-cache && apk info -e libexpat
USER 1001:1001
