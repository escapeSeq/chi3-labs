# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Caddy binds dual-stack on :$PORT (IPv4 + IPv6). Railway private
# networking is IPv6; Docker Compose healthchecks still use IPv4.
FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /etc/caddy/Caddyfile /entrypoint.sh && chmod +x /entrypoint.sh

ENV PORT=8083
EXPOSE 8083

ENTRYPOINT ["/entrypoint.sh"]
