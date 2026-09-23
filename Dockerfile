FROM node:20-bookworm AS node-runtime

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY zero-one-api-verifier/pyproject.toml zero-one-api-verifier/README.md zero-one-api-verifier/LICENSE ./zero-one-api-verifier/
COPY zero-one-api-verifier/src ./zero-one-api-verifier/src
RUN python -m venv zero-one-api-verifier/.venv \
    && zero-one-api-verifier/.venv/bin/pip install --no-cache-dir -e "zero-one-api-verifier[web]"

COPY . .

# 5173 = Vite 预览入口（会把 /leaderboard /partner 等代理到 verifier）
# 8012 = FastAPI 服务端口
EXPOSE 5173 8012

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
