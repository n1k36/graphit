# No dependencies to install, so this is about as small as a Node image gets.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# The SQLite file lives here; mount a volume so it survives a redeploy.
RUN mkdir -p /app/data
ENV PROGNOSE_DB=/app/data/prognose.db
ENV PORT=4173
VOLUME ["/app/data"]
EXPOSE 4173

# Drop privileges — the image ships with a non-root `node` user.
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:4173/api/stats > /dev/null || exit 1

CMD ["node", "--no-warnings", "server/server.js"]
