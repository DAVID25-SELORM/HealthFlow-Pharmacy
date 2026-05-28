FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4780

CMD ["node", "src/server.js"]
