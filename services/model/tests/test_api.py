from uuid import uuid4
from fastapi.testclient import TestClient

from forecast.api import app


def test_service_auth_validation_training_and_retry(tmp_path, monkeypatch, observations, config):
    token = "test-model-secret-" + "x" * 32
    monkeypatch.setenv("MODEL_SERVICE_TOKEN", token)
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"
        payload = {"run_id": str(uuid4()), "series_id": str(uuid4()), "observations": observations, "config": config.to_dict()}
        assert client.post("/train", json=payload).status_code == 401
        assert client.post("/train", json=payload, headers={"X-Service-Token": "incorrect"}).status_code == 401
        headers = {"X-Service-Token": token}
        result = client.post("/train", json=payload, headers=headers)
        assert result.status_code == 200
        assert client.post("/train", json=payload, headers=headers).json() == result.json()
        payload["config"]["seed"] += 1
        assert client.post("/train", json=payload, headers=headers).status_code == 409
        payload["config"]["extra"] = 1
        assert client.post("/train", json=payload, headers=headers).status_code == 422
        payload["observations"][0]["value"] = True
        assert client.post("/train", json=payload, headers=headers).status_code == 422
