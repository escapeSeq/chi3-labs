FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY www /srv
COPY entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
