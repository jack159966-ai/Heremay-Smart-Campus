FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js push-relay.js ./
ENV NODE_ENV=production
CMD ["npm","start"]
