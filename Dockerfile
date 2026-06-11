FROM node:26-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.json

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

VOLUME ["/data"]

CMD ["node", "src/index.ts"]
