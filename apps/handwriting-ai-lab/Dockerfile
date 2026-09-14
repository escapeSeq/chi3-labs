FROM python:3.12-slim

WORKDIR /lab

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

ENV PORT=8081
EXPOSE 8081

# Empty --host binds IPv4 and IPv6. Railway private networking is IPv6;
# healthchecks and Docker Compose still use IPv4.
CMD ["sh", "-c", "exec uvicorn app.main:app --host '' --port ${PORT:-8081}"]
