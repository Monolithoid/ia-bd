FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js .

USER node
CMD ["node", "server.js"]
