FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/model/requirements.txt services/model/constraints.txt ./
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY services/model/ ./
RUN useradd --create-home forecast && mkdir /artifacts && chown forecast /artifacts
USER forecast
EXPOSE 8000
CMD ["uvicorn", "forecast.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
