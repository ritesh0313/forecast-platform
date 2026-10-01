"""Internal API; deploy on a private network behind the authenticated Node worker."""

from contextlib import asynccontextmanager
import hmac
import logging
import os
from pathlib import Path
from typing import Annotated
from uuid import UUID

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictStr

from .config import Config
from .data import MAX_OBSERVATIONS, load_observations
from .pipeline import RunConflict, train

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    token = os.environ.get("MODEL_SERVICE_TOKEN", "")
    if len(token) < 32:
        raise RuntimeError("MODEL_SERVICE_TOKEN must be a randomly generated secret of at least 32 characters")
    app.state.service_token = token
    app.state.artifact_dir = Path(os.environ.get("ARTIFACT_DIR", "artifacts"))
    app.state.artifact_dir.mkdir(parents=True, exist_ok=True)
    yield


app = FastAPI(title="Internal forecasting service", version="0.1.0", lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)


class Observation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timestamp: StrictStr
    value: Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-1e12, le=1e12)]


class TrainingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: UUID
    series_id: UUID
    observations: Annotated[list[Observation], Field(min_length=1, max_length=MAX_OBSERVATIONS)]
    config: dict = Field(default_factory=dict)


def require_token(request: Request, x_service_token: Annotated[str | None, Header()] = None) -> None:
    if not x_service_token or not hmac.compare_digest(x_service_token.encode(), request.app.state.service_token.encode()):
        raise HTTPException(status_code=401, detail="Invalid service token")


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # Keep raw observations/credentials out of diagnostics and responses.
    return JSONResponse(status_code=422, content={"error": {"code": "invalid_request", "message": "Invalid fields, types, UUIDs, or observations bound"}})


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"error": {"code": "request_failed", "message": exc.detail}})


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "forecast-model"}


@app.post("/train", dependencies=[Depends(require_token)])
def train_endpoint(payload: TrainingRequest, request: Request) -> dict:
    try:
        config = Config.from_dict(payload.config)
        series = load_observations([row.model_dump() for row in payload.observations], config)
        return train(series, config, request.app.state.artifact_dir,
                     series_id=str(payload.series_id), run_id=str(payload.run_id))
    except RunConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (ValueError, OverflowError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception:
        logger.exception("Training failed for run %s", payload.run_id)
        raise HTTPException(status_code=500, detail="Training failed; inspect internal service logs") from None
