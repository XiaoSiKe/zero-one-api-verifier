FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY public ./public
COPY scripts ./scripts
COPY src ./src
COPY views ./views

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8020 8021
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8020/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
