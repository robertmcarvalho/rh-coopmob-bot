# Combined Dockerfile for Kelly (Webhook + WhatsApp middleware)
FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production || npm install --production
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
