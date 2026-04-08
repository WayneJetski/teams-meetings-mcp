FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* .npmrc ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 4005

CMD ["node", "src/index.js"]
