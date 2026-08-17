FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /data

ENV PORT=10000
ENV DATA_DIR=/data
ENV NODE_ENV=production

EXPOSE 10000
CMD ["node", "server.js"]
