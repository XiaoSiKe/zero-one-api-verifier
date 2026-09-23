FROM node:24-bookworm AS frontend-build

WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM caddy:2.11.4-alpine AS web
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY --from=frontend-build /site/dist /srv
ENV XDG_CONFIG_HOME=/tmp/caddy-config \
    XDG_DATA_HOME=/tmp/caddy-data
USER 10002:10002
EXPOSE 8080

FROM python:3.12-slim AS verifier

ARG INSTALL_CJK_FONTS=1
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VERIDROP_WEB_DATA_DIR=/data

RUN if [ "$INSTALL_CJK_FONTS" = "1" ]; then \
        apt-get update \
        && apt-get install --no-install-recommends -y fonts-noto-cjk \
        && rm -rf /var/lib/apt/lists/*; \
    fi \
    && useradd --system --uid 10001 --user-group --create-home verifier

WORKDIR /app/zero-one-api-verifier
COPY zero-one-api-verifier/pyproject.toml zero-one-api-verifier/README.md zero-one-api-verifier/LICENSE ./
COPY zero-one-api-verifier/src ./src
RUN pip install --no-cache-dir ".[web]"
COPY zero-one-api-verifier/web ./web
COPY zero-one-api-verifier/data/baselines ./data/baselines
RUN install -d -m 0700 -o 10001 -g 10001 /data

USER 10001:10001
EXPOSE 8012
CMD ["python", "-m", "uvicorn", "web.server:app", "--host", "0.0.0.0", "--port", "8012", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
