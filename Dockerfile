# Combined Dockerfile for Kelly (Webhook + WhatsApp middleware)
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm i --production --no-audit --no-fund
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["npm","start"]
