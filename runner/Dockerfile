# runner/Dockerfile
FROM node:20-alpine

WORKDIR /app

# 1) Copiar manifestos (si hay lock, lo usaremos)
COPY package*.json ./

# 2) Instalar deps: usa ci si hay lock, si no, install
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# 3) Copiar el resto del código
COPY . .

# 4) Railway inyecta PORT; Express debe escuchar process.env.PORT
EXPOSE 8080

CMD ["npm","start"]
