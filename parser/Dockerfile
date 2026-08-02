FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
EXPOSE 8000
# --timeout 1800: gunicorn-Default sind 30 s – ein PDF mit tausenden Seiten wird von
#   MarkItDown niemals in 30 s geparst, der Worker würde mit "WORKER TIMEOUT" gekillt.
# --workers 1: bewusst nur ein Worker – der geteilte Prod-Host (3,7 GB) hat keinen RAM
#   für zwei parallele MarkItDown-Instanzen. Importe laufen dann seriell.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--timeout", "1800", "--workers", "1", "main:app"]
