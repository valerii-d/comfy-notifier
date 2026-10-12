FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only the runtime code: no .env, keys, tests or docs end up in the image.
COPY --chown=node:node index.js ./
COPY --chown=node:node src ./src

USER node

# Exec form so SIGTERM from `docker stop` reaches Node and the bot stops gracefully.
CMD ["node", "index.js"]
