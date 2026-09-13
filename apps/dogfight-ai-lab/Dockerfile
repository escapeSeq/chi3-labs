FROM python:3.12-slim

WORKDIR /lab

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY main.py .

RUN mkdir -p /data

ENV PORT=8082
EXPOSE 8082

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8082}"]
