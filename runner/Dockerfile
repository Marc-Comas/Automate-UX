# runner/Dockerfile
FROM node:20-alpine

WORKDIR /app

# 1) Instalar deps con cache correcto
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# 2) Copiar el código
COPY . .

# 3) Railway inyecta PORT; Express debe escuchar process.env.PORT
EXPOSE 8080

CMD ["npm","start"]
