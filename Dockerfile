# Combined Dockerfile for Kelly (Webhook + WhatsApp middleware)
FROM node:18-alpine
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node","server.js"]
