# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM python:3.12-slim
WORKDIR /lab

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY --from=build /app/app/static ./app/static

ENV PORT=8080
EXPOSE 8080

# Empty --host binds IPv4 and IPv6. Railway private networking is IPv6;
# healthchecks and Docker Compose still use IPv4.
CMD ["sh", "-c", "exec uvicorn app.main:app --host '' --port ${PORT:-8080}"]
